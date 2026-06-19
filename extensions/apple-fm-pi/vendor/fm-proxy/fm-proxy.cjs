#!/usr/bin/env node
// fm-proxy.js - Fixes Apple fm serve compatibility with OpenAI-compatible clients
//
// fm serve has very limited JSON Schema support for tool parameters:
//   - Only FLAT schemas supported (no nested type:"object" in properties)
//   - "required" must be present on the root object
//   - No anyOf, allOf, oneOf, if/then/else, not, patternProperties
//   - enum, minimum, maximum, additionalProperties are OK
//   - arrays of primitives are OK
//
// This proxy aggressively simplifies tool schemas to work within these limits.
//
// Usage: node fm-proxy.js
// Proxies http://127.0.0.1:1977 -> http://127.0.0.1:1976

const http = require("http");
const { execFileSync } = require("child_process");
const FM_PORT = Number(process.env.FM_PORT) || 1976;
const PROXY_PORT = Number(process.env.PROXY_PORT) || 1977;

// fm serve (PCC) has two DISTINCT mid-stream failure modes that this proxy must NOT
// conflate — clients need to tell them apart because the remedy differs:
//   1. Rate-limit / capacity: HTTP 200 then an error frame ("LanguageModelError -1"),
//      rejecting at admission before any text. Transient; retry with backoff (below).
//   2. Safety-guardrail abort: the model emits valid output, THEN fm serve interrupts
//      ("The model's safety guardrails were triggered."). Deterministic + terminal +
//      PCC-only — retrying the identical request re-fails at the identical point, so we
//      do NOT retry; we surface it at once. Benign code triggers it, so it is NOT a
//      judgment that the user's content is unsafe.
// classifyError() maps each to an OpenAI-shaped outcome so clients can branch without
// string-matching Apple's prose:
//   - guardrail      → finish_reason:"content_filter" (keep partial; NOT an error — the
//                      OpenAI-idiomatic representation of a safety-stopped generation)
//   - rate-limit     → type:"rate_limit_exceeded" (retried, then surfaced)
//   - unavailability → type:"service_unavailable" (terminal; e.g. missing PCC attribution)
// Set FM_MAX_RETRIES=0 to disable rate-limit retries.
const MAX_RETRIES = Number(process.env.FM_MAX_RETRIES ?? 4);
const RETRY_BASE_MS = Number(process.env.FM_RETRY_BASE_MS ?? 1000);
const RETRY_CAP_MS = Number(process.env.FM_RETRY_CAP_MS ?? 15000);
const MAX_BODY_BYTES = Number(process.env.FM_PROXY_MAX_BODY_BYTES ?? 10 * 1024 * 1024);

// ── Token counting ───────────────────────────────────────────────────────────
// Apple's `fm serve` reports usage incorrectly: prompt_tokens is always 0
// (non-streaming) and streaming responses carry no usage at all. Pi reads these
// to drive its context gauge, so it always shows ~0%. We repair usage here.
//
// Strategy (hybrid): exact count for the prompt (the big, stable number) via
// Apple's own `fm token-count`; cheap heuristic for the streamed completion.
//
// Calibration (measured against `fm token-count`):
//   per-turn chat-template overhead ≈ 9 tokens; content ≈ chars / 4.4.
const PER_TURN_OVERHEAD = 9;
const CHARS_PER_TOKEN = 4.4;

function estimateTokens(text) {
  if (!text) return 0;
  return PER_TURN_OVERHEAD + Math.ceil(text.length / CHARS_PER_TOKEN);
}

// Flatten an OpenAI messages array into the text Apple's model actually sees.
// System messages map to instructions (-i); user/assistant/tool become the prompt.
function splitMessages(messages) {
  const instr = [];
  const prompt = [];
  for (const m of messages || []) {
    const content = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((p) => p.text || "").join("")
        : "";
    if (m.role === "system") instr.push(content);
    else prompt.push(content);
  }
  return { instructions: instr.join("\n"), prompt: prompt.join("\n") };
}

// Exact token count via `fm token-count -q`. Text is piped on stdin to avoid
// argv length limits; optional instructions go through -i so the count includes
// their (heavier) template wrapping, matching how the server frames a turn.
// Returns null if the binary is missing or errors (callers fall back to the
// heuristic).
// Memoize counts: each call forks `fm` (a synchronous spawn that blocks the event
// loop), and the heavy inputs — system prompt and flattened tool schemas — repeat
// verbatim on every turn. Counts are a pure function of (text, instructions), so a
// keyed cache turns those repeats into free lookups. Bounded to keep memory flat.
const _tokenCache = new Map();
const _TOKEN_CACHE_MAX = 512;
function fmTokenCount(text, instructions) {
  // fm token-count requires at least one input; skip the call entirely when both
  // are empty (e.g. tool-only turns) — the count is just the per-turn overhead.
  if (!text && !instructions) return PER_TURN_OVERHEAD;
  const key = (instructions || "") + "\0" + (text || "");
  if (_tokenCache.has(key)) return _tokenCache.get(key);
  let result = null;
  try {
    const args = ["token-count", "-q"];
    if (instructions) args.push("-i", instructions);
    const out = execFileSync("/usr/bin/fm", args, {
      input: text || "",
      encoding: "utf8",
      timeout: 5000,
    });
    const n = parseInt(out.trim(), 10);
    result = Number.isFinite(n) ? n : null;
  } catch {
    result = null;
  }
  // Cache only successful counts; a null is a transient failure worth retrying.
  if (result != null) {
    if (_tokenCache.size >= _TOKEN_CACHE_MAX) _tokenCache.clear();
    _tokenCache.set(key, result);
  }
  return result;
}

// Exact prompt token count for the full messages array. The fallback mirrors the
// exact path's single per-turn framing (one overhead, not one per concatenated
// string) by estimating the joined text in a single call.
function countPromptTokens(messages) {
  const { instructions, prompt } = splitMessages(messages);
  const n = fmTokenCount(prompt, instructions);
  return n != null ? n : estimateTokens(instructions + "\n" + prompt);
}

// ── Assembled-request instrumentation ────────────────────────────────────────
// The usage gauge (countPromptTokens) deliberately counts ONLY messages[].content
// — that is what Pi displays. But fm serve frames a much larger prompt: the
// flattened tool schemas, the assistant's prior tool_calls (which live in
// m.tool_calls, not m.content), and a per-turn template wrapper on EVERY turn.
// This breakdown measures the real assembled size so we can find PCC's true
// context ceiling empirically: log it for every request, then read off the value
// at the request where fm serve reports "transcript exceeded the model's context
// size". `fixedBody` is the post-fixTools payload actually forwarded upstream, so
// its `tools` are the flattened schemas the model really receives.
function assembledTokenBreakdown(parsedReq, fixedBody) {
  const messages = (parsedReq && parsedReq.messages) || [];
  // 1. messages content — the current gauge number.
  const msgTokens = countPromptTokens(messages);
  // 2. flattened tool schemas as forwarded to fm serve.
  let tools = (parsedReq && parsedReq.tools) || null;
  try { const f = JSON.parse(fixedBody); if (f && f.tools) tools = f.tools; } catch {}
  const toolsJson = tools && tools.length ? JSON.stringify(tools) : "";
  const toolTokens = toolsJson
    ? (fmTokenCount(toolsJson) ?? estimateTokens(toolsJson))
    : 0;
  // 3. assistant tool_calls — invisible to splitMessages (content is null).
  let toolCallText = "";
  for (const m of messages) {
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const fn = tc && tc.function;
        if (fn) toolCallText += (fn.name || "") + (fn.arguments || "");
      }
    }
  }
  const toolCallTokens = toolCallText
    ? (fmTokenCount(toolCallText) ?? estimateTokens(toolCallText))
    : 0;
  // 4. per-turn template framing applied once per non-system turn (the gauge
  //    collapses this to a single overhead for the whole concatenated prompt).
  const nonSystemTurns = messages.filter((m) => m.role !== "system").length;
  const perTurnExtra = PER_TURN_OVERHEAD * Math.max(0, nonSystemTurns - 1);
  const assembledTotal = msgTokens + toolTokens + toolCallTokens + perTurnExtra;
  return { msgTokens, toolTokens, toolCallTokens, perTurnExtra,
           turns: nonSystemTurns, assembledTotal };
}

function logBreakdown(tag, model, b) {
  console.error(
    `[assembled] ${tag} model=${model} turns=${b.turns} ` +
    `gauge(msgs)=${b.msgTokens} tools=${b.toolTokens} ` +
    `toolCalls=${b.toolCallTokens} perTurn=${b.perTurnExtra} ` +
    `=> assembled=${b.assembledTotal}`
  );
}

// Exact completion token count for accumulated streamed text; heuristic on fail.
function countCompletionTokens(text) {
  const n = fmTokenCount(text);
  return n != null ? n : estimateTokens(text);
}

// Decorative keys fm serve ignores but that still cost prompt tokens. Stripped
// from every property (and every embedded shape) with no loss of capability.
const DECORATIVE = [
  "title", "examples", "default", "$schema", "$id", "$comment",
  "readOnly", "writeOnly",
];

const STRIP_KEYS = new Set([
  "anyOf", "allOf", "oneOf", "if", "then", "else", "not",
  "$defs", "definitions", "$ref", "patternProperties",
  "description", ...DECORATIVE,
]);

// Keys to drop when embedding a nested schema as a JSON string in a param
// description. The shape only needs to convey structure + types, so prose-heavy /
// decorative keys are pure bloat repeated for every nested field.
const EMBED_STRIP_KEYS = new Set([
  "description", "additionalProperties", ...DECORATIVE,
]);

// Collapse a composition keyword (anyOf/oneOf/allOf) into a single schema, then
// re-simplify. `mergeAll` (allOf) unions every subschema with siblings winning;
// otherwise we pick the first typed branch (or the first) and let siblings fill
// gaps non-destructively.
function flattenComposite(prop, key, mergeAll) {
  const subs = prop[key] || [];
  let merged;
  if (mergeAll) {
    merged = {};
    for (const sub of subs) if (sub && typeof sub === "object") Object.assign(merged, sub);
    for (const [k, v] of Object.entries(prop)) if (k !== key) merged[k] = v;
  } else {
    const base = subs.find((s) => s && typeof s === "object" && s.type) || subs[0] || { type: "string" };
    merged = { ...base };
    for (const [k, v] of Object.entries(prop)) if (k !== key && !(k in merged)) merged[k] = v;
  }
  return simplifyProperty(merged);
}

function simplifyProperty(prop) {
  if (!prop || typeof prop !== "object") return prop;

  // Collapse composition keywords to a single schema.
  if (prop.anyOf) return flattenComposite(prop, "anyOf", false);
  if (prop.oneOf) return flattenComposite(prop, "oneOf", false);
  if (prop.allOf) return flattenComposite(prop, "allOf", true);

  // Objects can't be nested in a flat schema - collapse to string. Match
  // needsJsonRoundTrip: a bare `properties` block (no explicit type) is still an
  // object and must not survive into the forwarded schema.
  if (prop.type === "object" || prop.properties) {
    return { type: "string" };
  }

  // If it's an array, simplify items
  if (prop.type === "array") {
    const result = { type: "array" };
    if (prop.items) {
      result.items = simplifyProperty(prop.items);
    }
    if (prop.description) result.description = prop.description;
    return result;
  }

  // Keep primitive types, strip unsupported keys
  const result = {};
  for (const [k, v] of Object.entries(prop)) {
    if (!STRIP_KEYS.has(k)) result[k] = v;
  }
  return result;
}

// A top-level param needs the JSON-string round-trip if fm serve can't represent
// its shape: nested objects, or arrays whose items are objects. Such a param is
// declared to fm as a `type:"string"` carrying JSON, and the model's JSON reply is
// re-expanded back into the real object/array before forwarding to the client.
function needsJsonRoundTrip(prop) {
  if (!prop || typeof prop !== "object") return false;
  if (prop.type === "object" || prop.properties) return true;
  // Recurse through arrays so array<array<object>> (and deeper) is caught, not
  // just a single array<object> level.
  if (prop.type === "array") return needsJsonRoundTrip(prop.items);
  return false;
}

// Returns { schema, jsonFields } — jsonFields lists top-level params that were
// turned into JSON strings and must be JSON.parse'd back on the response.
function fixToolSchema(schema) {
  const result = { type: "object", required: [] };
  const jsonFields = [];
  if (!schema || typeof schema !== "object") {
    result.properties = {};
    return { schema: result, jsonFields };
  }

  result.properties = {};
  for (const [name, prop] of Object.entries(schema.properties || {})) {
    if (needsJsonRoundTrip(prop)) {
      jsonFields.push(name);
      const shape = JSON.stringify(prop, (k, v) =>
        EMBED_STRIP_KEYS.has(k) ? undefined : v);
      const desc = prop.description ? prop.description + " " : "";
      result.properties[name] = {
        type: "string",
        description: `${desc}JSON string matching: ${shape}`,
      };
    } else {
      result.properties[name] = simplifyProperty(prop);
    }
  }
  // Preserve the caller's `required` list. Dropping it told fm serve every param
  // was optional, so the model would emit partial/empty tool calls (e.g. edit with
  // `{}`) that the client then rejects against the real schema. JSON-round-tripped
  // params keep their name (only the value becomes a string), so names carry over.
  if (Array.isArray(schema.required)) {
    result.required = schema.required.filter((n) => n in result.properties);
  }
  return { schema: result, jsonFields };
}

// Rewrites request tools into fm-serve-compatible schemas. Returns the rewritten
// body, a coercion map (toolName -> [jsonField names]) for re-expansion on the
// response, and the parsed request object (or null) so callers needn't re-parse.
function fixTools(body) {
  try {
    const parsed = JSON.parse(body);
    const coercion = {};
    if (parsed.tools) {
      parsed.tools = parsed.tools.map((tool) => {
        const { schema, jsonFields } = fixToolSchema(tool.function?.parameters);
        if (jsonFields.length && tool.function?.name) {
          coercion[tool.function.name] = jsonFields;
        }
        return { ...tool, function: { ...tool.function, parameters: schema } };
      });
    }
    return { body: JSON.stringify(parsed), coercion, parsed };
  } catch {
    return { body, coercion: {}, parsed: null };
  }
}

// Re-expand JSON-string params in a tool_call's arguments back into real objects.
// `args` is the JSON string from the model; returns a (possibly) rewritten string.
function expandToolCallArguments(toolName, argsStr, coercion) {
  const fields = coercion[toolName];
  if (!fields || !fields.length) return argsStr;
  try {
    const obj = JSON.parse(argsStr);
    let changed = false;
    for (const f of fields) {
      if (typeof obj[f] === "string") {
        try { obj[f] = JSON.parse(obj[f]); changed = true; } catch { /* leave */ }
      }
    }
    return changed ? JSON.stringify(obj) : argsStr;
  } catch {
    return argsStr;
  }
}

// Apply expandToolCallArguments to every tool_call in an OpenAI tool_calls array
// (both streaming delta and non-streaming message shapes). Mutates in place;
// returns true if any arguments string was rewritten.
function rewriteToolCalls(toolCalls, coercion) {
  let changed = false;
  for (const tc of toolCalls) {
    const fn = tc && tc.function;
    if (!fn || typeof fn.arguments !== "string") continue;
    const next = expandToolCallArguments(fn.name, fn.arguments, coercion);
    if (next !== fn.arguments) { fn.arguments = next; changed = true; }
  }
  return changed;
}

// Classify an upstream fm-serve error message into a distinct OpenAI-shaped error type
// so clients can branch on the *cause* rather than string-matching Apple's prose. The two
// failure modes (see header comment) need different client remedies:
//   - rate-limit: transient, retry.
//   - safety-guardrail abort: deterministic + terminal, do NOT retry.
// `retry` tells the streaming/non-stream paths whether backoff is worthwhile.
function classifyError(msg) {
  const m = String(msg || "").toLowerCase();
  if (m.includes("guardrail"))
    return { type: "generation_aborted", code: "safety_guardrail", retry: false, label: "SAFETY-GUARDRAIL ABORT" };
  // PCC attribution / "not available in this context" (ModelManagerError 1013, HTTP 503
  // service_unavailable): deterministic + stable for the process's lifetime — retrying
  // just wastes ~15s. Distinct from a transient capacity 503.
  if (m.includes("not available in this context") || m.includes("service_unavailable"))
    return { type: "service_unavailable", code: "model_unavailable", retry: false, label: "MODEL UNAVAILABLE (PCC attribution)" };
  if (m.includes("languagemodelerror") || m.includes("error -1") || m.includes("rate limit") || m.includes("rate_limit"))
    return { type: "rate_limit_exceeded", code: -1, retry: true, label: "RATE-LIMIT" };
  return { type: "server_error", code: "internal_error", retry: true, label: "UPSTREAM ERROR" };
}

// Build an SSE error frame (`data: {"error":{...}}\n\n`) carrying a typed OpenAI error.
function errorFrame(cls, msg) {
  return `data: ${JSON.stringify({
    error: { message: msg || "upstream error", type: cls.type, code: cls.code },
  })}\n\n`;
}

// Exported for tests when required as a module; harmless when run directly.
if (require.main !== module) {
  module.exports = { fixTools, fixToolSchema, expandToolCallArguments, classifyError, errorFrame };
}

// CORS so browser-based OpenAI clients (open-webui, web apps hitting the base URL
// directly) clear their preflight. Origin is `*` by default; override with
// CORS_ORIGIN. Applied to every response via relayHead and the raw writeHead paths
// so no response can slip out without it.
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const CORS_HEADERS = {
  "access-control-allow-origin": CORS_ORIGIN,
  "access-control-allow-methods": "GET, POST, OPTIONS",
  // `*` covers Content-Type and the OpenAI SDK's x-stainless-* headers, but per
  // the Fetch spec the wildcard does NOT cover Authorization — it must be named
  // explicitly or browser preflight for the API key would fail.
  "access-control-allow-headers": "Authorization, *",
  "access-control-max-age": "86400", // cache preflight a day; fewer round-trips
};
function setCors(res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
}

// Copy upstream headers and either set Content-Length (non-stream, known body) or
// drop it (stream, chunked). One place so the two response paths can't desync.
// CORS headers are merged in here so every committed response carries them.
function relayHead(res, statusCode, upstreamHeaders, bodyLen) {
  const headers = { ...upstreamHeaders, ...CORS_HEADERS };
  // The proxy manages its own framing: it either sets Content-Length (buffered
  // body) or streams chunked. Never relay upstream's Transfer-Encoding, or the
  // response carries both CL and TE — illegal framing the client can't parse.
  delete headers["transfer-encoding"];
  if (bodyLen == null) delete headers["content-length"];
  else headers["content-length"] = bodyLen;
  res.writeHead(statusCode, headers);
}

const server = http.createServer((req, res) => {
  // CORS preflight: answer immediately, before buffering any body.
  if (req.method === "OPTIONS") {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // Decode as UTF-8 so multibyte characters split across TCP chunk boundaries are
  // reassembled by Node's StringDecoder instead of corrupting into U+FFFD.
  req.setEncoding("utf8");
  let body = "";
  let bodyTooLarge = false;
  req.on("data", (chunk) => {
    if (bodyTooLarge) return;
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      bodyTooLarge = true;
      if (!res.headersSent) {
        setCors(res);
        res.writeHead(413, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: `request body exceeds ${MAX_BODY_BYTES} bytes`,
              type: "invalid_request_error",
              code: "payload_too_large",
            },
          }),
        );
      }
      req.destroy();
    }
  });
  req.on("error", () => { /* client aborted upload; nothing to forward */ });
  req.on("end", () => {
    if (bodyTooLarge) return;
    const { body: fixed, coercion, parsed: parsedReq } = fixTools(body);

    const isChat = req.url && req.url.includes("/chat/completions");
    const isStream = !!(parsedReq && parsedReq.stream);
    // Compute the full assembled size fm serve actually frames (messages + tool
    // schemas + assistant tool_calls + per-turn framing). This both drives the
    // instrumentation log AND becomes the reported prompt_tokens, so Pi's context
    // gauge reflects the real budget instead of the messages-only slice (which
    // reads ~4x low and lets the transcript blow past PCC's ~32k ceiling
    // unwarned). Set GAUGE_MODE=msgs to fall back to the old messages-only number.
    let breakdown = null;
    if (isChat && parsedReq) {
      breakdown = assembledTokenBreakdown(parsedReq, fixed);
      logBreakdown("req", parsedReq.model || "unknown", breakdown);
    }
    const promptTokens = !isChat || !parsedReq
      ? 0
      : process.env.GAUGE_MODE === "msgs"
        ? breakdown.msgTokens
        : breakdown.assembledTotal;

    // One-line diagnostic binding a failure to this request's real assembled size
    // (the empirical PCC ceiling) — shared by the HTTP-status, context-overflow,
    // and stream-aborted cases so they stay in sync.
    const diag = (label, extra = "") => console.error(
      `[assembled] *** ${label} *** assembled=` +
      `${breakdown ? breakdown.assembledTotal : "?"} (gauge ${promptTokens})` +
      (extra ? ` ${extra}` : "")
    );

    // An SSE/JSON frame is an upstream *error* (not content) when it carries a
    // top-level `error` and no usable choices — that's the rate-limit signature.
    const isErrorPayload = (obj) =>
      obj && obj.error && !(obj.choices && obj.choices.length);

    // State shared across retry attempts. The client response (`res`) is the one
    // thing that persists; we don't commit its head until a good frame arrives so
    // a failed attempt can be replayed invisibly.
    let clientGone = false;
    let retryTimer = null;
    let activeProxyReq = null;

    // If the client disconnects, cancel any pending retry and tear down upstream.
    res.on("close", () => {
      clientGone = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      if (activeProxyReq) activeProxyReq.destroy();
    });
    res.on("error", () => { if (activeProxyReq) activeProxyReq.destroy(); });

    function scheduleRetry(attempt, reason) {
      if (attempt + 1 > MAX_RETRIES || clientGone) return false;
      const delay = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
      diag(`RETRY ${attempt + 1}/${MAX_RETRIES}`, `after ${reason}; waiting ${delay}ms`);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!clientGone) forward(attempt + 1);
      }, delay);
      return true;
    }

    // We always forward a fully-buffered body and set our own Content-Length, so
    // any inbound Transfer-Encoding (e.g. a client that streamed its upload with
    // chunked encoding) must be dropped — keeping both is illegal framing and
    // upstream rejects it with HPE_INVALID_CONTENT_LENGTH.
    const upstreamHeaders = { ...req.headers, "content-length": Buffer.byteLength(fixed) };
    delete upstreamHeaders["transfer-encoding"];

    function forward(attempt) {
      let aborting = false; // set when we tear the upstream down to retry
      const proxyReq = http.request(
        {
          hostname: "127.0.0.1",
          port: FM_PORT,
          path: req.url,
          method: req.method,
          headers: upstreamHeaders,
        },
        (proxyRes) => {
          proxyRes.setEncoding("utf8"); // same multibyte-safety as the request side
          if (isChat) diag(`UPSTREAM RESPONSE HTTP ${proxyRes.statusCode}`);
          proxyRes.on("error", (e) => { if (isChat) diag("UPSTREAM RES SOCKET ERROR", `— ${e.message}`); });

          // Only intervene on chat completions; everything else passes through.
          if (!isChat) {
            res.writeHead(proxyRes.statusCode, { ...proxyRes.headers, ...CORS_HEADERS });
            proxyRes.pipe(res);
            return;
          }

          // The client head is "committed" once we've written it (stream) or are
          // about to (non-stream). Before commit, a failure is retryable.
          let committed = false;
          const commit = () => {
            if (committed) return;
            committed = true;
            if (isStream) {
              relayHead(res, proxyRes.statusCode, proxyRes.headers, null);
              if (proxyRes.statusCode !== 200) diag(`UPSTREAM HTTP ${proxyRes.statusCode}`);
            }
          };
          // Abandon this attempt and retry if we haven't committed yet. Returns
          // true if a retry was scheduled (caller must stop touching the stream).
          const fail = (reason) => {
            if (committed || aborting) return false;
            if (!scheduleRetry(attempt, reason)) return false;
            aborting = true;
            proxyRes.destroy();
            proxyReq.destroy();
            return true;
          };

          if (isStream) {
            // Streaming: fm sends NO usage. Accumulate completion text from the
            // deltas, then inject a final usage chunk before [DONE].
            let completionText = "";
            let sawFinish = false;  // a clean finish_reason or [DONE] arrived
            let producedOutput = false; // any content or tool_calls delta seen
            let pending = "";       // line buffer across chunk boundaries
            let lastChunkMeta = null;
            let rawTail = "";       // last bytes of the upstream stream, for failure forensics
            let surfacedError = false; // we already forwarded a typed error frame
            let abortFinishReason = null; // set to "content_filter" on a guardrail abort
            // PCC always opens a stream with an empty {"delta":{"role":"assistant"}}
            // preamble, THEN either real output or an error frame. We must NOT commit
            // the client head on that preamble, or an error arriving right after it
            // would look post-commit and be unretryable. So buffer pre-output frames
            // and only commit on the first meaningful frame (content/tool_calls/finish).
            const preBuffer = [];
            const flushPre = () => { for (const l of preBuffer) res.write(l); preBuffer.length = 0; };
            const commitFlush = () => { commit(); flushPre(); };

            function pump(s, flush) {
              pending += s;
              let idx;
              while ((idx = pending.indexOf("\n")) !== -1 || (flush && pending.length)) {
                if (aborting) return;
                const line = idx !== -1 ? pending.slice(0, idx + 1) : pending;
                pending = idx !== -1 ? pending.slice(idx + 1) : "";
                const t = line.trim();
                // Context overflow is deterministic — never retry it, just surface.
                if (t.toLowerCase().includes("exceeded the model's context size")) {
                  diag("CONTEXT EXCEEDED", `— line: ${t}`);
                }
                let obj = null, isErr = false, errCls = null, meaningful = false;
                if (t.startsWith("data:")) {
                  const payload = t.slice(5).trim();
                  if (payload === "[DONE]") { sawFinish = true; if (!committed) commitFlush(); continue; }
                  try {
                    obj = JSON.parse(payload);
                    isErr = isErrorPayload(obj);
                    if (isErr) {
                      errCls = classifyError(obj.error && obj.error.message);
                    } else {
                      lastChunkMeta = { id: obj.id, model: obj.model, created: obj.created };
                      const ch0 = obj.choices && obj.choices[0];
                      if (ch0 && ch0.finish_reason) { sawFinish = true; meaningful = true; }
                      const delta = ch0 && ch0.delta;
                      if (delta && typeof delta.content === "string") { completionText += delta.content; producedOutput = true; meaningful = true; }
                      // Re-expand JSON-string tool-call args back to real objects.
                      if (delta && Array.isArray(delta.tool_calls)) {
                        producedOutput = true; meaningful = true;
                        if (rewriteToolCalls(delta.tool_calls, coercion)) {
                          if (!committed) commitFlush();
                          res.write(`data: ${JSON.stringify(obj)}\n\n`);
                          continue;
                        }
                      }
                    }
                  } catch { /* keepalive / non-JSON */ }
                } else if (/languagemodelerror|error -1/i.test(t)) {
                  isErr = true; // raw (non-data) error line
                  errCls = classifyError(t);
                } else if (t.startsWith("{")) {
                  // fm serve returns non-SSE errors (e.g. HTTP 503 service_unavailable
                  // for a missing-PCC-attribution `pcc` request) as BARE JSON, not a
                  // `data:` frame. Parse it so we classify + surface the typed error
                  // instead of treating the stream as empty and retrying blindly.
                  try {
                    obj = JSON.parse(t);
                    if (isErrorPayload(obj)) {
                      isErr = true;
                      errCls = classifyError(obj.error && obj.error.message);
                    }
                  } catch { /* not an error JSON */ }
                }
                // Safety-guardrail abort → OpenAI content_filter: keep any partial that
                // was already streamed, end the stream with finish_reason:"content_filter",
                // and emit NO error frame (so SDK clients get the partial + a documented
                // finish_reason instead of an exception). Only the guardrail maps to
                // content_filter; rate-limit and service_unavailable stay typed errors
                // (they're HTTP 429/503 analogues, not content filtering).
                if (isErr && errCls && errCls.type === "generation_aborted") {
                  diag(`${errCls.label}`, `— line: ${t}`);
                  abortFinishReason = "content_filter";
                  sawFinish = true;      // terminate the stream cleanly (no retry)
                  continue;              // drop the error frame; end handler emits the finish
                }
                // Pre-commit upstream error: retry only if transient (rate-limit). A
                // safety-guardrail abort is terminal — retrying re-fails identically —
                // so surface it immediately instead of burning the retry budget.
                if (isErr && !committed) {
                  diag(`${errCls.label} (pre-commit)`, `— line: ${t}`);
                  if (errCls.retry && fail("upstream error frame")) return;
                  surfacedError = true; // retries exhausted OR terminal: forward typed
                  meaningful = true;
                }
                if (!committed && !meaningful) {
                  // Preamble / keepalive before any real output — hold it so a
                  // following error frame is still pre-commit and retryable.
                  preBuffer.push(line);
                  continue;
                }
                if (!committed) commitFlush();
                // Forward content as-is; rewrite error frames to a typed OpenAI error so
                // clients can branch on `type` (rate_limit_exceeded / generation_aborted)
                // without string-matching Apple's message.
                if (isErr) {
                  const errMsg = (obj && obj.error && obj.error.message) || t;
                  res.write(errorFrame(errCls, errMsg));
                  if (!surfacedError) surfacedError = true;
                } else {
                  res.write(line);
                }
              }
            }

            proxyRes.on("data", (chunk) => {
              if (aborting) return;
              rawTail = (rawTail + chunk).slice(-2000); // keep a bounded tail for diagnostics
              pump(chunk, false);
            });

            proxyRes.on("end", () => {
              if (aborting) return;
              pump("", true); // flush any buffered partial line
              if (aborting) return; // pump may have triggered a retry
              if (!committed) {
                // Nothing forwardable arrived — empty/aborted stream. Retry it;
                // if exhausted, tell the client plainly instead of an empty 200.
                if (!sawFinish && completionText === "" && fail("empty stream (no finish)")) return;
                commit();
                if (!sawFinish && completionText === "" && !surfacedError) {
                  diag("GIVING UP (empty stream after retries)", `rawTail=${JSON.stringify(rawTail)}`);
                  res.write(errorFrame(classifyError("rate limit"),
                    "upstream returned no output (likely PCC rate limit) after retries"));
                }
              }
              if (!sawFinish && completionText !== "") {
                diag("UPSTREAM STREAM ABORTED (no finish)",
                  `completionChars=${completionText.length} rawTail=${JSON.stringify(rawTail)}`);
              }
              // Finished cleanly but produced neither text nor tool_calls — the
              // error path (error frame then [DONE]) that exhausted retries. Tool-
              // call turns set producedOutput, so they don't trip this.
              if (sawFinish && !producedOutput) {
                diag("EMPTY COMPLETION (finished, no output)",
                  `rawTail=${JSON.stringify(rawTail)}`);
              }
              const completionTokens = countCompletionTokens(completionText);
              const usage = {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
              };
              const meta = lastChunkMeta || {};
              const usageChunk = {
                id: meta.id || "chatcmpl-proxy",
                object: "chat.completion.chunk",
                created: meta.created || Math.floor(Date.now() / 1000),
                model: meta.model || (parsedReq && parsedReq.model) || "unknown",
                choices: [{ index: 0, delta: {}, finish_reason: abortFinishReason }],
                usage,
              };
              // We always suppress the upstream [DONE] and re-emit our own after a
              // synthetic usage chunk, so clients (Pi) that read the last
              // usage-bearing chunk get a real prompt_tokens.
              res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
              res.write("data: [DONE]\n\n");
              res.end();
            });
            return;
          }

          // Non-streaming: buffer fully (so we can still retry), then fix usage.
          let raw = "";
          proxyRes.on("data", (c) => (raw += c));
          proxyRes.on("end", () => {
            if (aborting) return;
            let obj = null;
            try { obj = JSON.parse(raw); } catch { /* not JSON */ }
            let outStatus = proxyRes.statusCode;
            if (isErrorPayload(obj)) {
              const cls = classifyError(obj.error && obj.error.message);
              diag(`${cls.label} (non-stream)`, `— ${raw.slice(0, 200)}`);
              if (cls.type === "generation_aborted") {
                // content_filter: return a normal completion finished by the filter
                // (OpenAI-aligned), not an error. fm serve's non-stream error carries
                // no partial, so content is empty; status is 200 (it's a valid completion).
                obj = {
                  id: "chatcmpl-proxy", object: "chat.completion",
                  model: (parsedReq && parsedReq.model) || "unknown",
                  choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "content_filter" }],
                  usage: { prompt_tokens: promptTokens, completion_tokens: 0, total_tokens: promptTokens },
                };
                outStatus = 200;
              } else {
                if (cls.retry && fail("non-stream error")) return;
                // terminal (service_unavailable) OR retries exhausted (rate-limit): type it.
                if (obj.error && typeof obj.error === "object") {
                  obj.error = { message: obj.error.message, type: cls.type, code: cls.code };
                }
              }
            }
            let out = raw;
            if (obj) {
              if (obj.usage) {
                obj.usage.prompt_tokens = promptTokens;
                obj.usage.total_tokens = promptTokens + (obj.usage.completion_tokens || 0);
              }
              // Re-expand JSON-string tool-call args back to real objects.
              const msg = obj.choices && obj.choices[0] && obj.choices[0].message;
              if (msg && Array.isArray(msg.tool_calls)) rewriteToolCalls(msg.tool_calls, coercion);
              out = JSON.stringify(obj);
            }
            committed = true;
            relayHead(res, outStatus, proxyRes.headers, Buffer.byteLength(out));
            res.end(out);
          });
        }
      );
      activeProxyReq = proxyReq;
      proxyReq.on("error", (e) => {
        // Transport-level failure (fm serve down / reset). Not the rate-limit
        // signature, and aborting=true means we tore it down on purpose to retry.
        if (aborting || clientGone || res.destroyed) return;
        if (isChat) diag("UPSTREAM REQ SOCKET ERROR", `— ${e.code || ""} ${e.message}`);
        // OpenAI-shaped error object (matches the stream-exhaustion path) so clients
        // parsing error.message get a string, not undefined.
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json", ...CORS_HEADERS });
        res.end(JSON.stringify({ error: { message: `fm serve unreachable: ${e.message}`, type: "server_error", code: "upstream_unreachable" } }));
      });
      proxyReq.write(fixed);
      proxyReq.end();
    }

    forward(0);
  });
});

// Only start listening when run directly; importing for tests must not bind.
if (require.main === module) {
  server.listen(PROXY_PORT, "127.0.0.1", () => {
    console.log(`fm-proxy listening on http://127.0.0.1:${PROXY_PORT}`);
    console.log(`  proxying to http://127.0.0.1:${FM_PORT}`);
    console.log(`  simplifies tool schemas to flat format for fm serve compatibility`);
  });
}
