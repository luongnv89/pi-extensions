import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  calculateCost,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type ModelThinkingLevel,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingLevelMap,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";

const PROVIDER_ID = "opencode-cli";
const API_ID = "opencode-cli-runner";
const AGENT_ID = "pi-model";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const DISCOVERY_TIMEOUT_MS = 8_000;
const STDERR_LIMIT = 20_000;

const DEFAULT_FREE_MODELS = [
  "opencode/deepseek-v4-flash-free",
  "opencode/mimo-v2.5-free",
  "opencode/nemotron-3-super-free",
  "opencode/big-pickle",
];
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly ModelThinkingLevel[];

export type OpenCodeModelInfo = {
  id: string;
  name: string;
  reasoning: boolean;
  image: boolean;
  contextWindow: number;
  maxTokens: number;
  cost: typeof ZERO_COST;
  thinkingLevelMap?: ThinkingLevelMap;
};

export type ParsedToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

let registeredModels: OpenCodeModelInfo[] = [];
let lastDiscoveryTime: number | undefined;
let lastDiscoveryError: string | undefined;

function opencodeBin(): string {
  return process.env.OPENCODE_PI_BIN?.trim() || "opencode";
}

function configuredModels(): string[] | undefined {
  const raw = process.env.OPENCODE_PI_MODELS?.trim();
  if (!raw) return undefined;
  return raw
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((model) => (model.includes("/") ? model : `opencode/${model}`));
}

function modelDisplayName(model: string): string {
  const [, id = model] = model.split(/\/(.*)/s);
  return `OpenCode ${id}`;
}

function contextWindowFor(model: string): number {
  if (model.includes("big-pickle")) return 200_000;
  return DEFAULT_CONTEXT_WINDOW;
}

function maxTokensFor(model: string): number {
  if (model.includes("big-pickle")) return 32_000;
  return DEFAULT_MAX_TOKENS;
}

function looksFree(model: string): boolean {
  return /(^opencode\/.*-free$)|(^opencode\/big-pickle$)/.test(model);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function fallbackModel(id: string): OpenCodeModelInfo {
  return {
    id,
    name: modelDisplayName(id),
    reasoning: false,
    image: false,
    contextWindow: contextWindowFor(id),
    maxTokens: maxTokensFor(id),
    cost: ZERO_COST,
  };
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function thinkingLevelMap(variants: unknown): ThinkingLevelMap {
  const map: ThinkingLevelMap = {};
  const names =
    typeof variants === "object" && variants !== null && !Array.isArray(variants)
      ? new Set(Object.keys(variants))
      : new Set<string>();

  for (const level of THINKING_LEVELS) {
    if (level === "off") {
      if (names.has("off")) map.off = "off";
      else if (names.has("none")) map.off = "none";
      continue;
    }
    map[level] = names.has(level) ? level : null;
  }
  if (!names.has("xhigh") && names.has("max")) map.xhigh = "max";
  return map;
}

export function reasoningCliArgs(
  requestedReasoning: ModelThinkingLevel | undefined,
  map?: ThinkingLevelMap,
): string[] {
  if (!requestedReasoning || requestedReasoning === "off") return [];

  const args = ["--thinking"];
  const variant = map?.[requestedReasoning];
  if (typeof variant === "string" && variant.trim()) {
    args.push("--variant", variant);
  }
  return args;
}

function findJsonObjectEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return undefined;
}

/** Parse the `model-id` + pretty-printed JSON pairs from OpenCode verbose discovery. */
export function parseVerboseModels(output: string): OpenCodeModelInfo[] {
  const records = new Map<string, OpenCodeModelInfo>();
  const idPattern = /^opencode\/[^\s]+\s*$/gm;
  for (const match of output.matchAll(idPattern)) {
    const id = match[0].trim();
    const metadataStart = (match.index ?? 0) + match[0].length;
    const objectStart = output.indexOf("{", metadataStart);
    if (objectStart < 0) continue;

    const nextId = output.slice(metadataStart).search(/^opencode\/[^\s]+\s*$/m);
    if (nextId >= 0 && objectStart >= metadataStart + nextId) continue;
    const objectEnd = findJsonObjectEnd(output, objectStart);
    if (objectEnd === undefined) continue;

    let metadata: unknown;
    try {
      metadata = JSON.parse(output.slice(objectStart, objectEnd));
    } catch {
      continue;
    }
    if (typeof metadata !== "object" || metadata === null) continue;

    const value = metadata as {
      name?: unknown;
      limit?: { context?: unknown; output?: unknown };
      capabilities?: { reasoning?: unknown; input?: { image?: unknown } };
      variants?: unknown;
    };
    const reasoning = value.capabilities?.reasoning === true;
    records.set(id, {
      id,
      name:
        typeof value.name === "string" && value.name.trim()
          ? value.name.trim()
          : modelDisplayName(id),
      reasoning,
      image: value.capabilities?.input?.image === true,
      contextWindow: positiveNumber(
        value.limit?.context,
        contextWindowFor(id),
      ),
      maxTokens: positiveNumber(value.limit?.output, maxTokensFor(id)),
      cost: ZERO_COST,
      ...(reasoning
        ? { thinkingLevelMap: thinkingLevelMap(value.variants) }
        : {}),
    });
  }
  return [...records.values()];
}

function runCapture(
  args: string[],
  input?: string,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(opencodeBin(), args, {
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...process.env, OPENCODE_DISABLE_UPDATE_CHECK: "1" },
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`opencode timed out after ${timeoutMs}ms`));
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

    if (input !== undefined) {
      child.stdin!.end(input);
    }
  });
}

async function discoverModels(): Promise<{
  models: OpenCodeModelInfo[];
  time: number;
  error: string | undefined;
}> {
  const configured = configuredModels();
  try {
    const result = await runCapture(["models", "opencode", "--verbose"]);
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() ||
          `opencode models exited with code ${result.code}`,
      );
    }

    const metadata = parseVerboseModels(result.stdout);
    if (metadata.length === 0) {
      throw new Error("opencode verbose model discovery returned no metadata");
    }
    const byId = new Map(metadata.map((model) => [model.id, model]));
    const selected = configured?.length
      ? dedupe(configured).map((id) => byId.get(id) ?? fallbackModel(id))
      : metadata.filter((model) => looksFree(model.id));
    if (selected.length === 0) {
      throw new Error("opencode verbose model discovery returned no free models");
    }

    lastDiscoveryError = undefined;
    return { models: selected, time: Date.now(), error: undefined };
  } catch (error) {
    lastDiscoveryError = error instanceof Error ? error.message : String(error);
    const fallbackIds = configured?.length
      ? dedupe(configured)
      : DEFAULT_FREE_MODELS;
    return {
      models: fallbackIds.map(fallbackModel),
      time: Date.now(),
      error: lastDiscoveryError,
    };
  }
}

async function refreshModels(
  pi: ExtensionAPI,
  ctx: { ui: { notify: (msg: string, level?: string) => void } },
): Promise<void> {
  const previousModels = new Set(registeredModels.map((model) => model.id));
  const { models, time, error } = await discoverModels();
  registeredModels = models;
  lastDiscoveryTime = time;

  // Re-register the provider with the updated model list
  const providerConfig: Parameters<ExtensionAPI["registerProvider"]>[1] = {
    name: "OpenCode CLI",
    baseUrl: "cli:opencode",
    apiKey: "opencode-cli-no-api-key",
    api: API_ID,
    models: models.map(providerModel),
    streamSimple: streamOpenCode,
  };

  try {
    pi.registerProvider(PROVIDER_ID, providerConfig);
  } catch {
    // registerProvider may reject if already registered; the models array is already updated.
  }

  const newModels = models.filter((model) => !previousModels.has(model.id));

  let msg = `opencode-pi: refreshed ${models.length} model(s).`;
  if (newModels.length > 0) {
    msg += ` ${newModels.length} new: ${newModels
      .slice(0, 5)
      .map((model) => model.id)
      .join(", ")}${newModels.length > 5 ? ", ..." : ""}`;
  }
  if (error) msg += ` Discovery issue: ${error}`;
  ctx.ui.notify(msg, "info");
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

function contentToText(
  content: string | (TextContent | ImageContent)[],
): string {
  if (typeof content === "string") return content;
  return content
    .map((item) => {
      if (item.type === "text") return item.text;
      return `[image in conversation: ${item.mimeType}, ${item.data.length} base64 chars]`;
    })
    .join("\n");
}

export function imageContentsForModel(
  messages: Message[],
  supportsImages: boolean,
): ImageContent[] {
  if (!supportsImages) return [];

  const images: ImageContent[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "toolResult") continue;
    if (typeof message.content === "string") continue;
    for (const content of message.content) {
      if (content.type === "image") images.push(content);
    }
  }
  return images;
}

function safeImageExtension(mimeType: string): string {
  const extensions: Record<string, string> = {
    "image/avif": ".avif",
    "image/bmp": ".bmp",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
  };
  return extensions[mimeType.toLowerCase()] ?? ".bin";
}

async function writeImageFiles(
  images: ImageContent[],
  directory: string,
): Promise<string[]> {
  const imageDir = join(directory, "pi-images");
  if (images.length > 0) await mkdir(imageDir, { recursive: true });
  return Promise.all(
    images.map(async (image, index) => {
      if (!image.mimeType.toLowerCase().startsWith("image/")) {
        throw new Error(`Unsupported image MIME type: ${image.mimeType}`);
      }
      const base64 = image.data.replace(/\s/g, "");
      if (
        !base64 ||
        base64.length % 4 === 1 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
      ) {
        throw new Error(`Invalid base64 data for image ${index + 1}`);
      }
      const data = Buffer.from(base64, "base64");
      if (data.length === 0) {
        throw new Error(`Empty image data for image ${index + 1}`);
      }
      const path = join(
        imageDir,
        `image-${String(index + 1).padStart(3, "0")}${safeImageExtension(image.mimeType)}`,
      );
      await writeFile(path, data);
      return path;
    }),
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function serializeMessage(message: Message): string {
  if (message.role === "user") {
    return `USER:\n${contentToText(message.content)}`;
  }

  if (message.role === "toolResult") {
    return [
      `PI TOOL RESULT (${message.toolName}, id=${message.toolCallId}, isError=${message.isError}):`,
      contentToText(message.content),
    ].join("\n");
  }

  const parts = message.content.map(
    (part: TextContent | ToolCall | { type: "thinking"; thinking: string }) => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking")
        return `<thinking>${part.thinking}</thinking>`;
      return `<pi_tool_call>${safeJson({ id: part.id, name: part.name, arguments: part.arguments })}</pi_tool_call>`;
    },
  );
  return `ASSISTANT:\n${parts.join("\n")}`;
}

function serializeTools(tools?: Tool[]): string {
  if (!tools || tools.length === 0)
    return "No Pi tools are available for this turn.";
  return safeJson(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  );
}

function buildPrompt(context: Context): string {
  const sections: string[] = [];
  sections.push(`# Pi/OpenCode bridge instructions

You are being used as the model backend for Pi Coding Agent through the OpenCode CLI.
OpenCode's own tools are disabled. Do not try to use OpenCode tools.

If you need Pi to run a tool, your entire response must contain only one or more tool-call blocks separated by whitespace:
<pi_tool_call>{"name":"tool_name","arguments":{}}</pi_tool_call>

Rules for Pi tool calls:
- Use only exact tool names listed in the "Available Pi tools" section.
- The JSON inside every marker must be valid JSON with a string "name" and an object "arguments".
- Markers are bridge control syntax. Never quote them, explain them, put them in prose, or wrap them in Markdown fences.
- Never output a marker as an example. A marker means you are requesting immediate execution.
- Do not put any text before or after tool-call markers. Mixed prose and markers will not execute.
- If you can answer without a tool, answer normally in plain text and do not emit any marker.
- After Pi returns tool results, match them to prior tool-call IDs in the transcript, then either answer or request another Pi tool call.`);

  if (context.systemPrompt?.trim()) {
    sections.push(`# Pi system prompt

${context.systemPrompt}`);
  }

  sections.push(`# Available Pi tools

${serializeTools(context.tools)}`);

  if (context.messages.length > 0) {
    sections.push(`# Conversation transcript

${context.messages.map(serializeMessage).join("\n\n---\n\n")}`);
  } else {
    sections.push("# Conversation transcript\n\n(no prior messages)");
  }

  sections.push("Now produce the next assistant message for Pi.");
  return sections.join("\n\n---\n\n");
}

const MARKER_OPEN = "<pi_tool_call>";
const MARKER_CLOSE = "</pi_tool_call>";

// Detects marker syntax anywhere in the response, not just at the start, so
// prose-then-marker and marker-then-prose responses are treated the same
// way: either both are rejected as malformed tool-call attempts, or neither
// is. A one-sided check let malformed leading prose silently leak raw
// marker text into the visible chat response while malformed trailing prose
// hard-failed the turn.
export function isToolCallMarkerResponse(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.includes(MARKER_OPEN) || trimmed.includes(MARKER_CLOSE);
}

// A closing marker inside a JSON string (e.g. tool arguments that happen to
// contain the literal text "</pi_tool_call>") must not be treated as the
// real boundary, so this walks the JSON string-escaping state rather than
// matching the close tag with a plain regex.
function findMarkerClose(text: string, from: number): number {
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (text.startsWith(MARKER_CLOSE, i)) return i;
  }
  return -1;
}

function toolCallMarkerBodies(text: string): string[] | undefined {
  const trimmed = text.trim();
  const bodies: string[] = [];
  let cursor = 0;
  while (cursor < trimmed.length) {
    const openIndex = trimmed.indexOf(MARKER_OPEN, cursor);
    if (openIndex === -1) break;
    if (trimmed.slice(cursor, openIndex).trim()) return undefined;

    const bodyStart = openIndex + MARKER_OPEN.length;
    const closeIndex = findMarkerClose(trimmed, bodyStart);
    if (closeIndex === -1) return undefined;

    bodies.push(trimmed.slice(bodyStart, closeIndex));
    cursor = closeIndex + MARKER_CLOSE.length;
  }
  if (bodies.length === 0) return undefined;
  if (trimmed.slice(cursor).trim()) return undefined;
  return bodies;
}

export function parseToolCalls(
  text: string,
  allowedToolNames?: ReadonlySet<string>,
): ParsedToolCall[] {
  const bodies = toolCallMarkerBodies(text);
  if (!bodies) return [];

  const parsed: ParsedToolCall[] = [];
  for (const body of bodies) {
    const calls = parseToolCallJson(body);
    if (
      calls.length === 0 ||
      calls.some(
        (call) => allowedToolNames && !allowedToolNames.has(call.name),
      )
    ) {
      return [];
    }
    parsed.push(...calls);
  }
  return parsed;
}

function parseArguments(value: unknown): Record<string, unknown> | undefined {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

function parseToolCallJson(raw: string): ParsedToolCall[] {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    return [];
  }

  const container = value as { tool_calls?: unknown } | null;
  const candidates = Array.isArray(value)
    ? value
    : Array.isArray(container?.tool_calls)
      ? container.tool_calls
      : [value];
  if (candidates.length === 0) return [];

  const calls: ParsedToolCall[] = [];
  for (const rawCandidate of candidates) {
    if (
      typeof rawCandidate !== "object" ||
      rawCandidate === null ||
      Array.isArray(rawCandidate)
    ) {
      return [];
    }
    const candidate = rawCandidate as {
      name?: unknown;
      tool?: unknown;
      arguments?: unknown;
      args?: unknown;
      input?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    const nameValue =
      typeof candidate.name === "string"
        ? candidate.name
        : typeof candidate.tool === "string"
          ? candidate.tool
          : candidate.function?.name;

    let argumentsValue: unknown;
    if (Object.hasOwn(candidate, "arguments")) {
      argumentsValue = candidate.arguments;
    } else if (Object.hasOwn(candidate, "args")) {
      argumentsValue = candidate.args;
    } else if (Object.hasOwn(candidate, "input")) {
      argumentsValue = candidate.input;
    } else if (
      candidate.function &&
      typeof candidate.function === "object" &&
      Object.hasOwn(candidate.function, "arguments")
    ) {
      argumentsValue = candidate.function.arguments;
    } else {
      return [];
    }

    const args = parseArguments(argumentsValue);
    if (
      typeof nameValue !== "string" ||
      !nameValue.trim() ||
      !args
    ) {
      return [];
    }
    calls.push({ name: nameValue, arguments: args });
  }
  return calls;
}

async function createTempAgentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencode-pi-"));
  const agentsDir = join(dir, ".opencode", "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(
    join(agentsDir, `${AGENT_ID}.md`),
    `---
description: Pi bridge agent. OpenCode tools are denied; Pi tool calls are emitted as text markers.
mode: primary
permission:
  "*": deny
  read: deny
  edit: deny
  glob: deny
  grep: deny
  list: deny
  bash: deny
  task: deny
  external_directory: deny
  todowrite: deny
  webfetch: deny
  websearch: deny
  lsp: deny
  skill: deny
  question: deny
  doom_loop: deny
---
You are the OpenCode side of a Pi Coding Agent bridge. OpenCode tools are disabled. Reply in plain text, or emit <pi_tool_call>{"name":"...","arguments":{...}}</pi_tool_call> exactly when the prompt asks you to request a Pi tool.
`,
    "utf8",
  );
  return dir;
}

function streamOpenCode(
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

    let tempDir: string | undefined;
    let accumulatedText = "";
    let accumulatedThinking = "";
    let stderr = "";
    let stdoutRemainder = "";
    let opencodeToolUse: string | undefined;
    let opencodeError: string | undefined;
    let finishReason: "stop" | "length" = "stop";
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const prompt = buildPrompt(context);

    try {
      stream.push({ type: "start", partial: output });
      if (options?.signal?.aborted) throw new Error("Request was aborted");

      tempDir = await createTempAgentDir();
      const images = imageContentsForModel(
        context.messages,
        model.input.includes("image"),
      );
      const imagePaths = await writeImageFiles(images, tempDir);
      const args = [
        "run",
        "--pure",
        "-m",
        model.id,
        "--agent",
        AGENT_ID,
        "--format",
        "json",
        "--dir",
        tempDir,
      ];
      const requestedReasoning = options?.reasoning as
        | ModelThinkingLevel
        | undefined;
      args.push(
        ...reasoningCliArgs(requestedReasoning, model.thinkingLevelMap),
      );
      for (const path of imagePaths) args.push("--file", path);

      const child = spawn(opencodeBin(), args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, OPENCODE_DISABLE_UPDATE_CHECK: "1" },
      });

      const abort = () => child.kill("SIGTERM");
      options?.signal?.addEventListener("abort", abort, { once: true });
      if (
        typeof options?.timeoutMs === "number" &&
        Number.isFinite(options.timeoutMs) &&
        options.timeoutMs > 0
      ) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, options.timeoutMs);
      }

      child.stdin!.end(prompt);
      child.stdout!.setEncoding("utf8");
      child.stderr!.setEncoding("utf8");

      const handleLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          stderr = (stderr + `\n${line}`).slice(-STDERR_LIMIT);
          return;
        }

        if (event.type === "text" && typeof event.part?.text === "string") {
          accumulatedText += event.part.text;
          return;
        }

        if (
          event.type === "reasoning" &&
          typeof event.part?.text === "string"
        ) {
          accumulatedThinking += event.part.text;
          return;
        }

        if (event.type === "step_finish") {
          if (/length|max.?tokens/i.test(String(event.part?.reason ?? ""))) {
            finishReason = "length";
          }
          if (!event.part?.tokens) return;
          const tokens = event.part.tokens;
          output.usage.input = Number(tokens.input ?? 0);
          output.usage.output =
            Number(tokens.output ?? 0) + Number(tokens.reasoning ?? 0);
          output.usage.cacheRead = Number(tokens.cache?.read ?? 0);
          output.usage.cacheWrite = Number(tokens.cache?.write ?? 0);
          output.usage.totalTokens = Number(
            tokens.total ??
              output.usage.input +
                output.usage.output +
                output.usage.cacheRead +
                output.usage.cacheWrite,
          );
          calculateCost(model, output.usage);
          return;
        }

        if (event.type === "tool_use") {
          opencodeToolUse = event.part?.tool
            ? String(event.part.tool)
            : "unknown";
          return;
        }

        if (event.type === "error") {
          const message =
            event.error?.data?.message ??
            event.error?.message ??
            event.part?.message;
          opencodeError =
            typeof message === "string" && message.trim()
              ? message.trim()
              : safeJson(event);
          stderr = (stderr + `\n${opencodeError}`).slice(-STDERR_LIMIT);
        }
      };

      child.stdout!.on("data", (chunk: string) => {
        stdoutRemainder += chunk;
        const lines = stdoutRemainder.split(/\r?\n/);
        stdoutRemainder = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      });
      child.stderr!.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_LIMIT);
      });

      const code = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      options?.signal?.removeEventListener("abort", abort);
      if (timer) clearTimeout(timer);
      if (stdoutRemainder.trim()) handleLine(stdoutRemainder);

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (timedOut) {
        throw new Error(`opencode timed out after ${options?.timeoutMs}ms`);
      }
      if (code !== 0) {
        throw new Error(stderr.trim() || `opencode exited with code ${code}`);
      }
      if (opencodeError) throw new Error(opencodeError);
      if (opencodeToolUse) {
        throw new Error(
          `OpenCode attempted to use its own tool (${opencodeToolUse}). opencode-pi disables OpenCode tools; use Pi tool-call markers only.`,
        );
      }

      const allowedToolNames = new Set(
        context.tools?.map((tool) => tool.name) ?? [],
      );
      const markerResponse = isToolCallMarkerResponse(accumulatedText);
      const toolCalls = parseToolCalls(accumulatedText, allowedToolNames);
      if (markerResponse && toolCalls.length === 0) {
        throw new Error(
          "opencode returned invalid or unavailable Pi tool-call markers",
        );
      }
      if (toolCalls.length === 0 && !accumulatedText.trim()) {
        throw new Error(
          stderr.trim() || "opencode returned no assistant text or tool calls",
        );
      }
      setEstimatedUsage(
        model,
        output,
        prompt,
        accumulatedText + accumulatedThinking,
      );

      if (accumulatedThinking) {
        const thinkingIndex = output.content.length;
        output.content.push({ type: "thinking", thinking: accumulatedThinking });
        stream.push({
          type: "thinking_start",
          contentIndex: thinkingIndex,
          partial: output,
        });
        stream.push({
          type: "thinking_delta",
          contentIndex: thinkingIndex,
          delta: accumulatedThinking,
          partial: output,
        });
        stream.push({
          type: "thinking_end",
          contentIndex: thinkingIndex,
          content: accumulatedThinking,
          partial: output,
        });
      }

      if (toolCalls.length > 0) {
        output.stopReason = "toolUse";
        for (const call of toolCalls) {
          const toolCall: ToolCall = {
            type: "toolCall",
            id: `opencode_pi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: call.name,
            arguments: call.arguments,
          };
          const contentIndex = output.content.length;
          output.content.push(toolCall);
          stream.push({
            type: "toolcall_start",
            contentIndex,
            partial: output,
          });
          stream.push({
            type: "toolcall_delta",
            contentIndex,
            delta: safeJson(toolCall.arguments),
            partial: output,
          });
          stream.push({
            type: "toolcall_end",
            contentIndex,
            toolCall,
            partial: output,
          });
        }
        stream.push({ type: "done", reason: "toolUse", message: output });
        stream.end();
        return;
      }

      output.stopReason = finishReason;
      const contentIndex = output.content.length;
      output.content.push({ type: "text", text: accumulatedText });
      stream.push({ type: "text_start", contentIndex, partial: output });
      if (accumulatedText) {
        stream.push({
          type: "text_delta",
          contentIndex,
          delta: accumulatedText,
          partial: output,
        });
      }
      stream.push({
        type: "text_end",
        contentIndex,
        content: accumulatedText,
        partial: output,
      });
      stream.push({ type: "done", reason: finishReason, message: output });
      stream.end();
    } catch (error) {
      if (timer) clearTimeout(timer);
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage =
        error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    } finally {
      if (timer) clearTimeout(timer);
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
  })();

  return stream;
}

function providerModel(model: OpenCodeModelInfo) {
  return {
    id: model.id,
    name: `${model.name} (OpenCode CLI)`,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap
      ? { thinkingLevelMap: model.thinkingLevelMap }
      : {}),
    input: model.image
      ? (["text", "image"] as ("text" | "image")[])
      : (["text"] as ("text" | "image")[]),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: model.cost,
  };
}

function statusLines(): string[] {
  const lines = [
    `Provider: ${PROVIDER_ID}`,
    `OpenCode binary: ${opencodeBin()}`,
    `OpenCode installed: ${existsSync(opencodeBin()) || opencodeBin() === "opencode" ? "check PATH with /opencode-pi test" : "no"}`,
    `Registered models: ${registeredModels.length}`,
    `Last discovery: ${lastDiscoveryTime ? new Date(lastDiscoveryTime).toLocaleString() : "never"}`,
  ];
  if (lastDiscoveryError)
    lines.push(`Discovery fallback: ${lastDiscoveryError}`);
  lines.push("");
  for (const model of registeredModels) {
    const capabilities = [
      model.reasoning ? "reasoning" : undefined,
      model.image ? "image" : undefined,
    ].filter(Boolean);
    lines.push(
      `  - ${PROVIDER_ID}/${model.id}${capabilities.length > 0 ? ` (${capabilities.join(", ")})` : ""}`,
    );
  }
  lines.push("");
  lines.push(
    "OpenCode login is not required for the bundled free OpenCode models.",
  );
  lines.push(
    "OpenCode tools are disabled; Pi tool use is bridged with prompt-level tool-call markers.",
  );
  lines.push(
    "Run /opencode-pi update to refresh the model list from opencode.",
  );
  return lines;
}

export default async function opencodePiExtension(pi: ExtensionAPI) {
  const { models, time } = await discoverModels();
  registeredModels = models;
  lastDiscoveryTime = time;

  pi.registerProvider(PROVIDER_ID, {
    name: "OpenCode CLI",
    baseUrl: "cli:opencode",
    apiKey: "opencode-cli-no-api-key",
    api: API_ID,
    models: registeredModels.map(providerModel),
    streamSimple: streamOpenCode,
  });

  pi.on("session_start", async (_event: any, ctx: any) => {
    ctx.ui.notify(
      `opencode-pi: registered ${registeredModels.length} OpenCode CLI model(s). Use /model and pick ${PROVIDER_ID}.`,
      "info",
    );
    if (lastDiscoveryError) {
      ctx.ui.notify(
        `opencode-pi: model discovery used fallback (${lastDiscoveryError})`,
        "warning",
      );
    }
  });

  pi.registerCommand("opencode-pi", {
    description: "OpenCode CLI bridge status and setup help",
    handler: async (args: string, ctx: any) => {
      const sub = args.trim().split(/\s+/).filter(Boolean)[0] ?? "status";
      if (sub === "status") {
        for (const line of statusLines()) ctx.ui.notify(line, "info");
        return;
      }
      if (sub === "models") {
        for (const model of registeredModels)
          ctx.ui.notify(`${PROVIDER_ID}/${model.id}`, "info");
        ctx.ui.notify(
          `Override with OPENCODE_PI_MODELS="opencode/model-a,opencode/model-b"`,
          "info",
        );
        return;
      }
      if (sub === "test") {
        ctx.ui.notify(
          `Run: pi -p --provider ${PROVIDER_ID} --model ${registeredModels[0]?.id ?? DEFAULT_FREE_MODELS[0]} "Reply with exactly OK"`,
          "info",
        );
        ctx.ui.notify(
          `OpenCode check: ${opencodeBin()} run -m ${registeredModels[0]?.id ?? DEFAULT_FREE_MODELS[0]} --format json "Reply OK"`,
          "info",
        );
        return;
      }
      if (sub === "update") {
        await refreshModels(pi, ctx);
        for (const line of statusLines()) ctx.ui.notify(line, "info");
        return;
      }
      if (sub === "help") {
        ctx.ui.notify(
          "Usage: /opencode-pi [status|models|test|update|help]",
          "info",
        );
        ctx.ui.notify(
          "Set OPENCODE_PI_BIN to override the opencode executable.",
          "info",
        );
        ctx.ui.notify(
          "Set OPENCODE_PI_MODELS to register a custom comma-separated model list.",
          "info",
        );
        return;
      }
      ctx.ui.notify(
        `Unknown /opencode-pi subcommand: ${sub}. Try /opencode-pi help`,
        "warning",
      );
    },
  });
}
