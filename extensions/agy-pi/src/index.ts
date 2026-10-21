import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  calculateCost,
  createAssistantMessageEventStream,
  registerApiProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type Tool,
} from "@earendil-works/pi-ai";

const PROVIDER_ID = "agy";
const API_ID = "agy-runner";
const AGENT_ID = "pi-model";
const DEFAULT_CONTEXT_WINDOW = 1_048_576;
const DEFAULT_MAX_TOKENS = 8_192;
const STDERR_LIMIT = 20_000;
const STATUS_TIMEOUT_MS = 10_000;
export const DEFAULT_TURN_TIMEOUT_MS = 180_000;

export type CliStatus = {
  ok: boolean;
  summary: string;
  detail?: string;
};
// Conservative argv budget for the `-p <prompt>` value (macOS caps a single
// arg at ~256KB and total argv at ~1MB).
const MAX_ARGV_PROMPT_BYTES = 100_000;

// Bundled model list matching `agy models` output. Effort variants
// (-high/-medium/-low) are collapsed into one base model per family whose
// thinking level picks the slug at request time.
function bundledModel(id: string, name: string, contextWindow = 1_048_576): AgyModelInfo {
  return { id, name, contextWindow, maxTokens: DEFAULT_MAX_TOKENS, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}

export const BUNDLED_MODELS: AgyModelInfo[] = [
  bundledModel("gemini-4-argon-high", "Gemini 4 Argon"),
  bundledModel("gemini-4-argon-medium", "Gemini 4 Argon"),
  bundledModel("gemini-4-argon-low", "Gemini 4 Argon"),
  bundledModel("gemini-3.8-flash-high", "Gemini 3.8 Flash"),
  bundledModel("gemini-3.8-flash-medium", "Gemini 3.8 Flash"),
  bundledModel("gemini-3.8-flash-low", "Gemini 3.8 Flash"),
  bundledModel("claude-opus-5-5-high", "Claude Opus 5.5"),
  bundledModel("claude-opus-5-5-medium", "Claude Opus 5.5"),
  bundledModel("claude-opus-5-5-low", "Claude Opus 5.5"),
  bundledModel("claude-sonnet-5-5-high", "Claude Sonnet 5.5"),
  bundledModel("claude-sonnet-5-5-medium", "Claude Sonnet 5.5"),
  bundledModel("claude-sonnet-5-5-low", "Claude Sonnet 5.5"),
  bundledModel("gpt-oss-120b-medium", "GPT-OSS 120B", 128_000),
];

export interface AgyModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  reasoning?: boolean;
  image?: boolean;
  /** Reasoning-effort variants exposed by agy for this family (e.g. low/medium/high). */
  effortLevels?: string[];
}

let registeredModels: AgyModelInfo[] = [];
let lastDiscoveryTime: number | undefined;
let lastDiscoveryError: string | undefined;
let lastCliStatus: CliStatus | undefined;
let providerRegisteredCount = 0;
let providerRegisteredSource: "environment override" | "cached catalog" | "bundled catalog" = "bundled catalog";
let catalogPendingReload = false;

const AGY_PANEL_STATUS = "Provider status";
const AGY_PANEL_CONFIG = "Configuration (source presence)";
const AGY_PANEL_MODELS = "Models (registered)";
const AGY_PANEL_HELP = "Help / navigation";
const AGY_PANEL_BACK = "Back";
const AGY_PANEL_CLOSE = "Close";

export function agyBin(): string {
  return process.env.AGY_PI_BIN?.trim() || "agy";
}

/** Build the install/setup instructions shown when the agy CLI is unusable. */
export function setupGuidance(error: string): string {
  return [
    "agy-pi could not use the local agy CLI.",
    `Reason: ${error}`,
    "Install agy (`pip install agy-cli` or `pipx install agy-cli`), ensure `agy --version` works on PATH, then reload Pi.",
    "Set AGY_PI_BIN to override the executable path.",
  ].join(" ");
}

// Model catalog cache. Stable per-OS-user path (~/.cache/agy-pi/models.json
// on Linux with XDG_CACHE_HOME honored, ~/Library/Caches/agy-pi/models.json
// on macOS), overridable with AGY_PI_CACHE for tests and sandboxes.
const CACHE_SCHEMA = 1;

const CACHE_PROBE_COOLDOWN_MS = 60_000;

export function cacheFilePath(): string {
  const override = process.env.AGY_PI_CACHE?.trim();
  if (override) return override;
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", "agy-pi", "models.json");
  }
  const base = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  return join(base, "agy-pi", "models.json");
}

export type ModelCache = {
  schema: number;
  fetchedAt: string;
  catalog: AgyModelInfo[];
};

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Validate a parsed cache file into AgyModelInfo entries, or undefined if any record is unrecognizable. */
function catalogFromRaw(raw: unknown): AgyModelInfo[] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.schema !== CACHE_SCHEMA) return undefined;
  if (typeof record.fetchedAt !== "string" || !record.fetchedAt.trim()) return undefined;
  if (!Array.isArray(record.catalog) || record.catalog.length === 0) return undefined;
  const models: AgyModelInfo[] = [];
  for (const entry of record.catalog) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const model = entry as Record<string, unknown>;
    if (typeof model.id !== "string" || !model.id.trim()) return undefined;
    if (typeof model.name !== "string" || !model.name.trim()) return undefined;
    if (!finiteNumber(model.contextWindow) || !finiteNumber(model.maxTokens)) return undefined;
    const cost = model.cost;
    if (!cost || typeof cost !== "object" || Array.isArray(cost)) return undefined;
    const costRecord = cost as Record<string, unknown>;
    if (
      !finiteNumber(costRecord.input) ||
      !finiteNumber(costRecord.output) ||
      !finiteNumber(costRecord.cacheRead) ||
      !finiteNumber(costRecord.cacheWrite)
    ) {
      return undefined;
    }
    let effortLevels: string[] | undefined;
    if (model.effortLevels !== undefined) {
      if (
        !Array.isArray(model.effortLevels) ||
        !model.effortLevels.every((level) => typeof level === "string" && !!level)
      ) {
        return undefined;
      }
      effortLevels = model.effortLevels as string[];
    }
    models.push({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      cost: {
        input: costRecord.input,
        output: costRecord.output,
        cacheRead: costRecord.cacheRead,
        cacheWrite: costRecord.cacheWrite,
      },
      ...(effortLevels ? { effortLevels } : {}),
    });
  }
  return models;
}

/**
 * Read the model catalog cache. Corrupt/unrecognized/missing files are
 * treated as absent (the next successful write replaces the file). Other
 * read failures (permissions, directory path) are recorded verbatim in
 * cacheReadError() so the status panel can surface them; they still do not
 * block registration.
 */
let lastCacheReadError: string | undefined;

/** Reason the last cache read failed, when it was not simply absent. */
export function cacheReadError(): string | undefined {
  return lastCacheReadError;
}

export function readModelCache(path = cacheFilePath()): AgyModelInfo[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error: any) {
    lastCacheReadError = error?.code === "ENOENT" ? undefined : `cache unreadable: ${error?.code ?? "unknown"}`;
    return undefined;
  }
  lastCacheReadError = undefined;
  return catalogFromRaw(parsed);
}

/** Model ids are CLI slugs; anything with whitespace or shell punctuation is a banner line, not a model. */
function isPlausibleModelId(id: string): boolean {
  return id.length <= 100 && /^[A-Za-z0-9._:/@-]+$/.test(id);
}

/**
 * Atomically overwrite the cache file: temp file in the same directory, then
 * rename. All failures (missing dir, permissions, quota) are silent. Models
 * whose id does not look like a CLI model id (CLI banners, parse drift) must
 * never be persisted: a poisoned cache would outrank the bundled catalog on
 * every later load, so un-persistable ids are filtered and empty result means
 * no write instead of keeping whatever the parser produced.
 */
export function writeModelCache(models: AgyModelInfo[], path = cacheFilePath()): boolean {
  const writable = models.filter((m) => isPlausibleModelId(m.id));
  if (!writable.length) return false;
  try {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    const payload: ModelCache = {
      schema: CACHE_SCHEMA,
      fetchedAt: new Date().toISOString(),
      catalog: writable,
    };
    const temp = join(dir, `.${basename(path)}.${Date.now()}.${process.pid}.tmp`);
    try {
      writeFileSync(temp, JSON.stringify(payload));
      renameSync(temp, path);
      return true;
    } finally {
      rmSync(temp, { force: true });
    }
  } catch {
    return false;
  }
}

function configuredModels(): string[] | undefined {
  const raw = process.env.AGY_PI_MODELS?.trim();
  if (!raw) return undefined;
  return raw
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function modelDisplayName(model: string): string {
  return `Agy ${model}`;
}

function effortOf(id: string): string | undefined {
  return id.match(/-(high|medium|low)$/)?.[1];
}

function baseIdOf(id: string): string {
  const effort = effortOf(id);
  return effort ? id.slice(0, id.length - effort.length - 1) : id;
}

function stripEffortName(name: string): string {
  return name.replace(/\s+\((High|Medium|Low)\)$/i, "").trim();
}

function bundledForBase(baseId: string): AgyModelInfo | undefined {
  const match = BUNDLED_MODELS.find((m) => m.id === baseId || baseIdOf(m.id) === baseId);
  return match ? { ...match } : undefined;
}

/**
 * Parse `agy models` stdout. Each line is `id<TAB>name` (extra columns ignored).
 * Id-only lines (no tab) are kept so a bare-id CLI still works.
 */
export function parseAgyModelsOutput(stdout: string): Array<{ id: string; name?: string }> {
  const models: Array<{ id: string; name?: string }> = [];
  for (const raw of stdout.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const [idField, nameField] = raw.split("\t");
    const id = idField?.trim() ?? "";
    if (!id) continue;
    const name = nameField?.trim();
    models.push(name ? { id, name } : { id });
  }
  return models;
}

export type AgyModelRef = string | { id: string; name?: string };

/** Collapse -high/-medium/-low variant ids into one base model per family. */
export function toBaseModels(refs: AgyModelRef[]): AgyModelInfo[] {
  const groups = new Map<string, { levels: Set<string>; bundled?: AgyModelInfo; name?: string }>();
  const seen = new Set<string>();
  for (const ref of refs) {
    const id = typeof ref === "string" ? ref.trim() : ref.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof ref === "string" ? undefined : ref.name?.trim();
    const effort = effortOf(id);
    const baseId = effort ? id.slice(0, id.length - effort.length - 1) : id;
    let group = groups.get(baseId);
    if (!group) {
      group = { levels: new Set(), bundled: bundledForBase(baseId) };
      groups.set(baseId, group);
    }
    if (effort) group.levels.add(effort);
    if (name && !group.name) group.name = stripEffortName(name);
  }
  return [...groups.entries()].map(([baseId, group]) => ({
    id: baseId,
    name: group.name ?? group.bundled?.name ?? modelDisplayName(baseId),
    contextWindow: group.bundled?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: group.bundled?.maxTokens ?? DEFAULT_MAX_TOKENS,
    cost: group.bundled?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: group.bundled?.reasoning,
    image: group.bundled?.image,
    ...(group.levels.size ? { effortLevels: [...group.levels] } : {}),
  }));
}

const EFFORT_ORDER = ["low", "medium", "high"];

/**
 * Resolve the agy model slug for a request. Base families with effort
 * variants get `-<level>` appended based on the selected thinking level;
 * off/minimal map to low and xhigh maps to high.
 */
export function agySlugForLevel(modelId: string, level?: string): string {
  const info = registeredModels.find((m) => m.id === modelId);
  const levels = info?.effortLevels ?? [];
  if (!levels.length) return modelId;
  let want =
    level === "high" || level === "xhigh"
      ? "high"
      : level === "medium"
        ? "medium"
        : "low"; // low, minimal, off, or unset -> cheapest
  if (!levels.includes(want)) {
    // Clamp to the nearest available effort level (ties go lower).
    const wantIdx = EFFORT_ORDER.indexOf(want);
    want = [...levels]
      .sort(
        (a, b) =>
          Math.abs(EFFORT_ORDER.indexOf(a) - wantIdx) -
            Math.abs(EFFORT_ORDER.indexOf(b) - wantIdx) ||
          EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b),
      )[0];
  }
  return `${modelId}-${want}`;
}

async function runCapture(
  args: string[],
  timeoutMs = 10_000,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(agyBin(), args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`agy timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr!.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-STDERR_LIMIT);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

/** Probe the agy CLI with `agy --version` to detect a missing/broken install. */
export async function checkAgyStatus(): Promise<CliStatus> {
  try {
    const result = await runCapture(["--version"], STATUS_TIMEOUT_MS);
    if (result.code !== 0) {
      const detail =
        result.stderr.trim() ||
        result.stdout.trim() ||
        `agy --version exited with code ${result.code}`;
      return { ok: false, summary: "agy CLI is unusable", detail };
    }
    const version =
      result.stdout.trim() || result.stderr.trim() || "agy is available";
    return { ok: true, summary: version };
  } catch (error) {
    return {
      ok: false,
      summary: "agy CLI is unavailable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function discoverModels(opts?: {
  forceDiscovery?: boolean;
}): Promise<{
  models: AgyModelInfo[];
  time: number;
  error: string | undefined;
}> {
  const now = Date.now();
  const configured = configuredModels();

  // Fast path: explicit model list with no force flag
  if (configured?.length && !opts?.forceDiscovery) {
    lastDiscoveryError = undefined;
    registeredModels = toBaseModels(configured);
    lastDiscoveryTime = now;
    return { models: registeredModels, time: now, error: undefined };
  }

  // Discovery: run `agy models`
  try {
    const { stdout, code } = await runCapture(["models"]);
    if (code !== 0) {
      lastDiscoveryError = stdout.trim() || "agy models exited with code " + code;
      if (configured?.length) {
        registeredModels = toBaseModels(configured);
        lastDiscoveryTime = now;
        return { models: registeredModels, time: now, error: undefined };
      }
      lastDiscoveryTime = now;
      return { models: [], time: now, error: lastDiscoveryError };
    }

    const parsed = parseAgyModelsOutput(stdout);

    registeredModels = toBaseModels(configured?.length ? configured : parsed);

    lastDiscoveryTime = now;
    lastDiscoveryError = undefined;
    return { models: registeredModels, time: now, error: undefined };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    lastDiscoveryError = msg;
    if (configured?.length) {
      registeredModels = toBaseModels(configured);
      lastDiscoveryTime = now;
      return { models: registeredModels, time: now, error: undefined };
    }
    lastDiscoveryTime = now;
    return { models: [], time: now, error: msg };
  }
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Effective per-turn timeout: honor Pi's `timeoutMs` when it is a positive
 * finite number, otherwise fall back to the unconditional internal bound so
 * no turn can hang indefinitely (#88).
 */
export function resolveTurnTimeoutMs(timeoutMs: unknown): number {
  return typeof timeoutMs === "number" &&
    Number.isFinite(timeoutMs) &&
    timeoutMs > 0
    ? timeoutMs
    : DEFAULT_TURN_TIMEOUT_MS;
}

/** Build the prompt text from Pi messages for agy --print */
function buildPrompt(context: Context): string {
  return context.messages
    .map((msg) => {
      if (msg.role === "user") {
        return `USER:\n${typeof msg.content === "string" ? msg.content : msg.content.map(c => c.type === "text" ? c.text : "").join("\n")}`;
      }
      if (msg.role === "assistant") {
        return `ASSISTANT:\n${typeof msg.content === "string" ? msg.content : msg.content.map(c => c.type === "text" ? c.text : "").join("\n")}`;
      }
      if (msg.role === "toolResult") {
        return `TOOL_RESULT:\n${typeof msg.content === "string" ? msg.content : msg.content.map(c => c.type === "text" ? c.text : "").join("\n")}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Build the agy invocation args for a request. The model flag is pinned on
 * both paths: `--model` must come before `-p` (agy quirk, upstream #83/#581),
 * and oversized prompts fall back to the stdin `--print` path with `--model`
 * kept, so the fallback never silently runs the CLI default model (#92).
 */
export function agyArgs(slug: string, prompt: string): string[] {
  return Buffer.byteLength(prompt) <= MAX_ARGV_PROMPT_BYTES
    ? ["--model", slug, "-p", prompt]
    : ["--model", slug, "--print"];
}

/** Stream agy output via `agy --print --model <id>` */
export function streamAgy(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };

    let stderr = "";
    let stdout = "";
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Single stable content index for the whole response (#90).
    const contentIndex = 0;
    let textStarted = false;
    let textEnded = false;

    try {
      stream.push({ type: "start", partial: output });
      if (options?.signal?.aborted) throw new Error("Request was aborted");

      const prompt = buildPrompt(context);
      // agy quirk (upstream issues #83/#581): --model must come BEFORE -p,
      // otherwise print mode silently ignores it and runs the default model.
      // Oversized prompts fall back to the stdin `--print` path, still with
      // `--model` pinned first so the CLI never silently runs its default
      // model (#92).
      const useArgvPrompt = Buffer.byteLength(prompt) <= MAX_ARGV_PROMPT_BYTES;
      const slug = agySlugForLevel(model.id, options?.reasoning);
      const args = agyArgs(slug, prompt);

      const child = spawn(agyBin(), args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      const abort = () => child.kill("SIGTERM");
      options?.signal?.addEventListener("abort", abort, { once: true });
      // Every turn is bounded by an internal timeout even when Pi supplies
      // no timeoutMs; the handle is kept so the timer can be cleared (#88).
      const turnTimeoutMs = resolveTurnTimeoutMs(options?.timeoutMs);
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, turnTimeoutMs);

      child.stdin!.end(useArgvPrompt ? undefined : prompt);
      child.stdout!.setEncoding("utf8");
      child.stderr!.setEncoding("utf8");

      // Emit each chunk exactly once: one text_start before the first chunk,
      // one delta per chunk holding only the new bytes, one text_end after
      // close. The content array is never replaced, so contentIndex stays
      // valid for the whole response (#90).
      let textBlock: { type: "text"; text: string } | undefined;
      child.stdout!.on("data", (chunk: string) => {
        if (textEnded) return;
        stdout += chunk;
        if (!textStarted) {
          textStarted = true;
          textBlock = { type: "text", text: "" };
          output.content = [textBlock];
          stream.push({ type: "text_start", contentIndex, partial: output });
        }
        textBlock!.text = stdout;
        stream.push({ type: "text_delta", contentIndex, delta: chunk, partial: output });
      });

      child.stderr!.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-STDERR_LIMIT);
      });

      let spawnError: Error | undefined;
      let code: number | null = null;
      try {
        code = await new Promise<number | null>((resolve, reject) => {
          child.on("error", reject);
          child.on("close", resolve);
        });
      } catch (error) {
        spawnError = error instanceof Error ? error : new Error(String(error));
      } finally {
        // Cleanup runs on success, error, timeout and abort alike: the abort
        // listener is detached and the timer is cleared on every exit path
        // (#88, #89).
        options?.signal?.removeEventListener("abort", abort);
        if (timer) clearTimeout(timer);
        timer = undefined;
        textEnded = true;
      }

      if (spawnError) {
        throw new Error(
          setupGuidance(`failed to launch ${agyBin()}: ${spawnError.message}`),
        );
      }

      // Derive the turn outcome from abort, timeout and the exit code (#87).
      // Abort and timeout first: a killed child reports a null exit code.
      if (options?.signal?.aborted) throw new Error("Request was aborted");
      if (timedOut) throw new Error(`agy timed out after ${turnTimeoutMs}ms`);
      if (code !== 0) {
        throw new Error(stderr.trim() || `agy exited with code ${code}`);
      }

      if (textStarted) {
        stream.push({ type: "text_end", contentIndex, content: stdout, partial: output });
      } else {
        // A genuinely empty successful run stays distinguishable from any
        // failure above (#87).
        const placeholder = "No response from agy.";
        output.content = [{ type: "text", text: placeholder }];
        stream.push({ type: "text_start", contentIndex, partial: output });
        stream.push({ type: "text_delta", contentIndex, delta: placeholder, partial: output });
        stream.push({ type: "text_end", contentIndex, content: placeholder, partial: output });
      }
      output.stopReason = "stop";

      const lastUserMsg = context.messages[context.messages.length - 1];
      const promptText = lastUserMsg ? (typeof lastUserMsg.content === "string" ? lastUserMsg.content : lastUserMsg.content.map(c => c.type === "text" ? c.text : "").join("\n")) : "";
      setEstimatedUsage(model, output, promptText, stdout.trim());

      stream.push({ type: "done", reason: "stop", message: output });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = errMsg;
      // Ensure output.content has text so downstream consumers see a real
      // message instead of an empty turn (partial text stays as streamed).
      if (output.content.length === 0) {
        output.content.push({ type: "text", text: `Error: ${errMsg}` });
      }
      stream.push({ type: "error", reason: output.stopReason, error: output });
    }
  })();

  return stream;
}

function setEstimatedUsage(
  model: Model<Api>,
  output: AssistantMessage,
  prompt: string,
  text: string,
) {
  if (output.usage.totalTokens > 0) return;
  output.usage.input = estimateTokens(prompt);
  output.usage.output = estimateTokens(text);
  output.usage.totalTokens = output.usage.input + output.usage.output;
  calculateCost(model, output.usage);
}

const ALL_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;

/**
 * Families with effort variants (effortLevels) expose low/medium/high as
 * thinking levels; agySlugForLevel translates the selected level back to the
 * -low/-medium/-high slug at request time. Claude and GPT-OSS models accept
 * low/medium/high too; minimal is mapped to low.
 */
function thinkingConfig(model: AgyModelInfo): {
  reasoning: boolean;
  thinkingLevelMap?: Record<(typeof ALL_LEVELS)[number], string | null>;
} {
  if (model.effortLevels?.length) {
    const available = new Set(model.effortLevels);
    const map = Object.fromEntries(
      ALL_LEVELS.map((l) => [
        l,
        l === "minimal" || l === "xhigh"
          ? null
          : available.has(l)
            ? l
            : null,
      ]),
    ) as Record<(typeof ALL_LEVELS)[number], string | null>;
    return { reasoning: true, thinkingLevelMap: map };
  }
  if (/^claude-|^gpt-oss/.test(model.id)) {
    return {
      reasoning: true,
      thinkingLevelMap: {
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: null,
      },
    };
  }
  return { reasoning: model.reasoning ?? false };
}

function providerModel(model: AgyModelInfo) {
  const inputTypes: Array<"text" | "image"> = model.image ? ["text", "image"] : ["text"];
  const { reasoning, thinkingLevelMap } = thinkingConfig(model);
  return {
    id: model.id,
    name: `${model.name} (Agy)`,
    reasoning,
    ...(reasoning && thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: inputTypes,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: model.cost,
  };
}

function panelEnvState(name: string): string {
  return process.env[name]?.trim() ? "set" : "default";
}

function panelCliState(): string {
  if (!lastCliStatus) return "not checked";
  return lastCliStatus.ok ? "available" : "unavailable";
}

function panelProviderStatusLines(): string[] {
  return [
    `Provider: ${PROVIDER_ID}`,
    `agy CLI: ${panelCliState()}`,
    "Authentication: delegated to agy CLI (contents not inspected)",
    `Registered models: ${providerRegisteredCount}`,
    `Discovery: ${lastDiscoveryError ? "last attempt failed (details hidden)" : lastDiscoveryTime ? "ready" : "not attempted"}`,
  ];
}

function panelConfigurationLines(): string[] {
  return [
    `AGY_PI_BIN: ${panelEnvState("AGY_PI_BIN")}`,
    `AGY_PI_MODELS: ${panelEnvState("AGY_PI_MODELS")}`,
    "Credentials: managed externally by agy CLI (contents not read)",
    `Registered model source: ${providerRegisteredSource}`,
    ...(catalogPendingReload ? [`Latest catalog source: ${panelEnvState("AGY_PI_MODELS") === "set" ? "environment override" : "CLI discovery"} (requires /reload)`] : []),
  ];
}

function panelModelLines(): string[] {
  return [
    `Registered models: ${providerRegisteredCount}`,
    ...(catalogPendingReload
      ? [`Latest discovered models: ${pendingCatalogModels?.length ?? registeredModels.length} (requires /reload)`]
      : []),
    "Availability: registered in the Pi provider; CLI model availability not checked",
    "Registered count does not prove that the CLI can serve every model.",
  ];
}

function panelHelpLines(): string[] {
  return [
    "Read-only view: no refresh, update, test, login, model calls, or configuration edits.",
    "Use Up/Down to navigate and Enter to inspect a section.",
    "Use Back to return to the sections, or Close/Escape to leave the panel.",
    "Explicit /agy-pi status, models, test, update, and help commands are unchanged.",
  ];
}

export async function showAgyPanelList(ctx: any, title: string, lines: string[]): Promise<string | undefined> {
  // Keep each ASCII detail to at most two selector rows at 40 columns.
  const records = (lines.length ? lines : ["No details available."]).flatMap((line) =>
    line ? Array.from({ length: Math.ceil(line.length / 40) }, (_, index) => line.slice(index * 40, (index + 1) * 40)) : [""],
  );
  let page = 0;
  while (true) {
    const detail = `• ${records[page]}`;
    const options = [
      detail,
      ...(page > 0 ? ["Previous"] : []),
      ...(page < records.length - 1 ? ["Next"] : []),
      AGY_PANEL_BACK,
      AGY_PANEL_CLOSE,
    ];
    const counter = ` (${page + 1}/${records.length})`;
    let heading = title;
    if (heading.length + counter.length > 38) heading = heading.replace(/\s+\([^()]*\)$/u, "");
    if (heading.length + counter.length > 38) heading = heading.slice(0, Math.min(30, 38 - counter.length));
    const choice = await ctx.ui.select(`${heading}${counter}`, options);
    if (choice === undefined || choice === AGY_PANEL_CLOSE || choice === AGY_PANEL_BACK) return choice;
    if (choice === "Previous" && page > 0) page -= 1;
    if (choice === "Next" && page < records.length - 1) page += 1;
  }
}

async function showAgyPanel(ctx: any): Promise<void> {
  while (true) {
    const choice = await ctx.ui.select("agy-pi (read-only)", [
      AGY_PANEL_STATUS,
      AGY_PANEL_CONFIG,
      AGY_PANEL_MODELS,
      AGY_PANEL_HELP,
      AGY_PANEL_CLOSE,
    ]);
    if (choice === undefined || choice === AGY_PANEL_CLOSE) return;

    if (choice === AGY_PANEL_STATUS) {
      const detailChoice = await showAgyPanelList(ctx, "agy-pi provider status", panelProviderStatusLines());
      if (detailChoice === undefined || detailChoice === AGY_PANEL_CLOSE) return;
      continue;
    }
    if (choice === AGY_PANEL_CONFIG) {
      const detailChoice = await showAgyPanelList(ctx, "agy-pi configuration (source presence)", panelConfigurationLines());
      if (detailChoice === undefined || detailChoice === AGY_PANEL_CLOSE) return;
      continue;
    }
    if (choice === AGY_PANEL_MODELS) {
      const detailChoice = await showAgyPanelList(ctx, "agy-pi models (registered)", panelModelLines());
      if (detailChoice === undefined || detailChoice === AGY_PANEL_CLOSE) return;
      continue;
    }
    if (choice === AGY_PANEL_HELP) {
      const detailChoice = await showAgyPanelList(ctx, "agy-pi help / navigation", panelHelpLines());
      if (detailChoice === undefined || detailChoice === AGY_PANEL_CLOSE) return;
      continue;
    }

    return;
  }
}

function statusLines(): string[] {
  const lines = [
    `Provider: ${PROVIDER_ID}`,
    `agy binary: ${agyBin()}`,
    `agy installed: ${existsSync(agyBin()) || agyBin() === "agy" ? "yes (via PATH)" : "no"}`,
    `Registered models: ${registeredModels.length}`,
    `Last discovery: ${lastDiscoveryTime ? new Date(lastDiscoveryTime).toLocaleString() : "never"}`,
  ];
  if (lastDiscoveryError)
    lines.push(`Discovery issue: ${lastDiscoveryError}`);
  lines.push("");
  for (const model of registeredModels) {
    lines.push(`  - ${PROVIDER_ID}/${model.id} (${model.name})`);
  }
  lines.push("");
  lines.push("Set AGY_PI_MODELS=\"gemini-3.8-flash-high,gpt-oss-120b-medium\" to use specific models.");
    lines.push(`Catalog cache: ${cacheFilePath()}`);
    const readError = cacheReadError();
    if (readError) lines.push(readError);
    lines.push("Run /agy-pi update to refresh the model list and cache.");
  return lines;
}

/**
 * Fire-and-forget catalog refresh: probe `agy models`, atomically overwrite
 * the cache on success. The refreshed catalog is kept in pendingCatalog()
 * for status display only; the running session's registered models are never
 * touched here so an in-flight turn cannot lose its effort clamping
 * mid-request. It applies on the next load. All failures are silent.
 */
let pendingCatalogModels: AgyModelInfo[] | undefined;
let catalogRefreshInFlight: Promise<void> | undefined;
let catalogRefreshStartedAt = 0;

/** The most recent successful discovery, status-only (not registered). */
export function pendingCatalog(): AgyModelInfo[] | undefined {
  return pendingCatalogModels;
}

export function refreshCatalogCache(): Promise<void> {
  // Coalesce only genuinely rapid duplicate triggers (session_start racing the
  // load path). An older slow probe keeps running on its own; a newer one
  // starts against the current environment instead of inheriting stale env.
  if (catalogRefreshInFlight && Date.now() - catalogRefreshStartedAt < 1000) {
    return catalogRefreshInFlight;
  }
  catalogRefreshStartedAt = Date.now();
  const run = runCatalogRefresh().catch(() => {
    // silent by design
  });
  catalogRefreshInFlight = run;
  void run.finally(() => {
    if (catalogRefreshInFlight === run) catalogRefreshInFlight = undefined;
  });
  return run;
}

async function runCatalogRefresh(): Promise<void> {
  if (configuredModels()) return;
  // Skip a redundant probe when an existing cache is still fresh (rapid reloads, sibling processes).
  if (cacheCacheFresh()) return;
  // discoverModels() reassigns the module registeredModels as a side effect
  // (pre-existing); background refresh must stay status-only, so snapshot the
  // registered set and restore it once the probe finishes. The comparison is
  // made against the snapshot, not the probe-mutated state.
  const previouslyRegistered = registeredModels;
  const { models, time, error } = await discoverModels({ forceDiscovery: true });
  registeredModels = previouslyRegistered;
  if (error || !models.length) return;
  if (writeModelCache(models)) {
    pendingCatalogModels = models;
    lastDiscoveryTime = time;
    lastDiscoveryError = undefined;
    catalogPendingReload = !sameCatalogIds(models, previouslyRegistered);
  }
}

/** True when an existing cache was written within the cooldown window. */
function cacheCacheFresh(): boolean {
  try {
    return Date.now() - statSync(cacheFilePath()).mtimeMs < CACHE_PROBE_COOLDOWN_MS;
  } catch {
    return false;
  }
}

/** Set when the discovered catalog differs from the registered one; next load applies it. */
function sameCatalogIds(a: AgyModelInfo[], b: AgyModelInfo[]): boolean {
  if (a.length !== b.length) return false;
  const ids = new Set(b.map((m) => m.id));
  return a.every((m) => ids.has(m.id));
}

export default function agyPiExtension(pi: ExtensionAPI) {
  // Register synchronously from cached/env-configured/bundled models so the
  // provider exists before any session starts. Async CLI discovery here
  // resolves after session replacement and makes the extension ctx stale
  // (registerProvider throws "ctx is stale"), so the provider never loads.
  // The background refresh below only writes the cache for the next load.
  const configured = configuredModels();
  const cached = configured ? undefined : readModelCache();
  registeredModels = cached ?? toBaseModels(configured ?? BUNDLED_MODELS.map((m) => m.id));
  providerRegisteredCount = registeredModels.length;
  providerRegisteredSource = configured
    ? "environment override"
    : cached
      ? "cached catalog"
      : "bundled catalog";
  catalogPendingReload = false;

  pi.registerProvider(PROVIDER_ID, {
    name: "Agy",
    baseUrl: "cli:agy",
    apiKey: "agy-cli-no-api-key",
    api: API_ID,
    models: registeredModels.map(providerModel),
    streamSimple: streamAgy,
  });

  registerApiProvider(
    {
      api: API_ID,
      stream: (model, context, options) => streamAgy(model, context, options),
      streamSimple: streamAgy,
    },
    PROVIDER_ID,
  );

  // Registration is done; fire-and-forget the cache refresh for next load.
  void refreshCatalogCache();

  pi.on("session_start", async (_event: any, ctx: any) => {
    lastCliStatus = await checkAgyStatus();
    const cliStatus = lastCliStatus;
    if (!cliStatus.ok) {
      ctx.ui.notify(
        `agy-pi: ${setupGuidance(cliStatus.detail ?? cliStatus.summary)}`,
        "warning",
      );
      return;
    }
    ctx.ui.notify(
      `agy-pi: registered ${registeredModels.length} model(s). Use /model and pick ${PROVIDER_ID}.`,
      "info",
    );
  });

  pi.registerCommand("agy-pi", {
    description: "Agy CLI bridge status and setup help",
    handler: async (args: string, ctx: any) => {
      const trimmedArgs = args.trim();
      if (trimmedArgs.length === 0 && ctx.mode === "tui" && ctx.hasUI) {
        await showAgyPanel(ctx);
        return;
      }

      const sub = trimmedArgs.split(/\s+/).filter(Boolean)[0] ?? "status";
      if (sub === "status") {
        for (const line of statusLines()) ctx.ui.notify(line, "info");
        return;
      }
      if (sub === "models") {
        for (const model of registeredModels)
          ctx.ui.notify(`${PROVIDER_ID}/${model.id}`, "info");
        ctx.ui.notify(
          `Override with AGY_PI_MODELS="gemini-3.8-flash-high,claude-sonnet-5-5-high"`,
          "info",
        );
        return;
      }
      if (sub === "test") {
        const testModel = registeredModels[0]?.id ?? BUNDLED_MODELS[0]?.id ?? "gemini-3.6-flash-high";
        ctx.ui.notify(
          `Run: pi -p --provider ${PROVIDER_ID} --model ${testModel} "Reply with exactly OK"`,
          "info",
        );
        return;
      }
      if (sub === "update") {
        const { models, time, error } = await discoverModels({ forceDiscovery: true });
        registeredModels = models;
        lastDiscoveryTime = time;
        catalogPendingReload = !error && models.length > 0;
        pendingCatalogModels = models.length ? models : undefined;
        writeModelCache(models);
        for (const line of statusLines()) ctx.ui.notify(line, "info");
        ctx.ui.notify(
          "Run /reload to apply the refreshed model list to the provider.",
          "info",
        );
        return;
      }
      if (sub === "help") {
        ctx.ui.notify("Usage: /agy-pi [status|models|test|update|help]", "info");
        ctx.ui.notify("Set AGY_PI_BIN to override the agy executable.", "info");
        ctx.ui.notify("Set AGY_PI_MODELS to register a custom comma-separated model list.", "info");
        return;
      }
      ctx.ui.notify(
        `Unknown /agy-pi subcommand: ${sub}. Try /agy-pi help`,
        "warning",
      );
    },
  });
}
