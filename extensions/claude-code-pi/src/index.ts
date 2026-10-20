import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  calculateCost,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Model,
  type ModelThinkingLevel,
  type SimpleStreamOptions,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";

export const PROVIDER_ID = "claude-code-cli";
const API_ID = "claude-code-cli-runner";
const DEFAULT_CONTEXT_WINDOW = 1_000_000;
const DEFAULT_MAX_TOKENS = 16_384;
const STATUS_TIMEOUT_MS = 4_000;
const REQUEST_TIMEOUT_MS = 5 * 60_000;
// setTimeout fires at once for delays above 2^31-1 ms (about 24.8 days).
const MAX_TIMER_MS = 2_147_483_647;
const STDERR_LIMIT = 20_000;
// After an abort or timeout, SIGKILL whatever ignored SIGTERM this long.
const KILL_GRACE_MS = 2_000;

export type ClaudeCodeModelInfo = {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
};

// Output limits are the `maxOutputTokens` Claude Code reports in `modelUsage`
// for each alias (claude 2.1.304: sonnet/opus/haiku 128K, fable 64K).
const DEFAULT_MODELS: ClaudeCodeModelInfo[] = [
  {
    id: "sonnet",
    name: "Claude Code Sonnet alias",
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: 128_000,
    reasoning: true,
  },
  {
    id: "opus",
    name: "Claude Code Opus alias",
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: 128_000,
    reasoning: true,
  },
  {
    id: "fable",
    name: "Claude Code Fable alias",
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: 64_000,
    reasoning: true,
  },
  {
    id: "haiku",
    name: "Claude Code Haiku alias",
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: 128_000,
    reasoning: true,
  },
];

let registeredModels: ClaudeCodeModelInfo[] = configuredModels(process.env.CLAUDE_CODE_PI_MODELS);
let lastCliStatus: CliStatus | undefined;

const CLAUDE_PANEL_STATUS = "Provider status";
const CLAUDE_PANEL_CONFIG = "Configuration (source presence)";
const CLAUDE_PANEL_MODELS = "Models (registered)";
const CLAUDE_PANEL_HELP = "Help / navigation";
const CLAUDE_PANEL_BACK = "Back";
const CLAUDE_PANEL_CLOSE = "Close";

function claudeBin(): string {
  return process.env.CLAUDE_CODE_PI_BIN?.trim() || "claude";
}

/** Quote a value for the copy-paste commands we print; spawn() itself never goes through a shell. */
function shellQuote(value: string): string {
  return /^[\w./:+,-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function requestTimeoutMs(): number {
  const configured = Number(process.env.CLAUDE_CODE_PI_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) return Math.min(configured, MAX_TIMER_MS);
  return REQUEST_TIMEOUT_MS;
}

function timeoutEnvWarning(): string | undefined {
  const raw = process.env.CLAUDE_CODE_PI_TIMEOUT_MS?.trim();
  const configured = Number(raw);
  if (!raw || (Number.isFinite(configured) && configured > 0)) return undefined;
  return `claude-code-pi: CLAUDE_CODE_PI_TIMEOUT_MS is not a positive number of milliseconds; using the default ${REQUEST_TIMEOUT_MS}.`;
}

function contextWindowOverride(): number | undefined {
  const raw = process.env.CLAUDE_CODE_PI_CONTEXT_WINDOW?.trim() ?? "";
  const configured = Number(raw);
  // Whole token counts only: Number() alone also takes "0x10", "0.5" and "1e6".
  if (/^\d+$/.test(raw) && Number.isSafeInteger(configured) && configured > 0) return configured;
  return undefined;
}

function contextWindowEnvWarning(): string | undefined {
  if (!process.env.CLAUDE_CODE_PI_CONTEXT_WINDOW?.trim() || contextWindowOverride() !== undefined) return undefined;
  return `claude-code-pi: CLAUDE_CODE_PI_CONTEXT_WINDOW is not a positive whole number of tokens; using the default ${DEFAULT_CONTEXT_WINDOW}.`;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

export function configuredModels(raw: string | undefined): ClaudeCodeModelInfo[] {
  const defaults = new Map(DEFAULT_MODELS.map((model) => [model.id, model]));
  // Bundled aliases match in any case ("Sonnet", "HAIKU") and register under their canonical id.
  const configured = raw
    ?.split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (defaults.has(part.toLowerCase()) ? part.toLowerCase() : part));

  const ids = configured && configured.length > 0 ? dedupe(configured) : DEFAULT_MODELS.map((model) => model.id);
  const contextWindow = contextWindowOverride();

  return ids.map((id) => {
    const known = defaults.get(id);
    if (known && !contextWindow) return known;
    return {
      id,
      name: known?.name ?? `Claude Code ${id}`,
      contextWindow: contextWindow ?? known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: known?.maxTokens ?? DEFAULT_MAX_TOKENS,
      reasoning: true,
    };
  });
}

// Pi thinking level → `claude --effort` value. Pi 1.x adds `max` and only
// offers `xhigh`/`max` for models whose thinkingLevelMap declares them, so the
// same map is registered on every model.
export const EFFORT_BY_LEVEL: Record<string, string> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

export function effortArgs(level: ModelThinkingLevel | "max" | undefined): string[] {
  if (!level || level === "off") return [];
  return ["--effort", EFFORT_BY_LEVEL[level] ?? "high"];
}

export function buildClaudeArgs(
  modelId: string,
  reasoning?: ModelThinkingLevel | "max",
  useStreamJson = false,
): string[] {
  const args = [
    "-p",
    "--model",
    modelId,
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    // `--tools ""` only removes the built-in tools; MCP servers (including
    // claude.ai connectors) and skills stay loaded without these two flags.
    "--tools",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
  ];
  args.push(...effortArgs(reasoning));
  if (useStreamJson) {
    args.push("--input-format", "stream-json", "--output-format", "stream-json", "--verbose");
  } else {
    // Verbose mode in the user's Claude Code config turns this into one JSON
    // array of every event; parseClaudeOutput reads both shapes.
    args.push("--output-format", "json");
  }
  return args;
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

/** The final `result` event Claude Code prints with `--output-format json` or `stream-json`. */
type ClaudeResultEvent = {
  type?: string;
  is_error?: boolean;
  subtype?: unknown;
  result?: unknown;
  /** Set instead of `result` on `error_during_execution` and `error_max_turns`. */
  errors?: unknown;
  stop_reason?: unknown;
  total_cost_usd?: unknown;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
};

export type ClaudeOutput = {
  text: string;
  isError: boolean;
  /** False when stdout held no `result` event, e.g. a crash or an older CLI. */
  hasResult: boolean;
  stopReason?: string;
  responseModel?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; costTotal: number };
};

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** The model that wrote the answer: the `modelUsage` entry with the most output tokens. */
function answeringModel(modelUsage: Record<string, unknown> | undefined): string | undefined {
  let best: string | undefined;
  let bestOutput = -1;
  for (const [id, usage] of Object.entries(modelUsage ?? {})) {
    const output = tokenCount((usage as { outputTokens?: unknown } | null)?.outputTokens);
    if (output > bestOutput) {
      best = id;
      bestOutput = output;
    }
  }
  return best;
}

/** Real token usage and cost as reported by Claude Code, replacing the length estimate. */
function applyClaudeUsage(output: AssistantMessage, usage: NonNullable<ClaudeOutput["usage"]>) {
  output.usage.input = usage.input;
  output.usage.output = usage.output;
  output.usage.cacheRead = usage.cacheRead;
  output.usage.cacheWrite = usage.cacheWrite;
  output.usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  // Claude Code only reports a total (`total_cost_usd`), not a per-category split.
  output.usage.cost.total = usage.costTotal;
}

type BridgeContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  mimeType?: string;
  data?: string;
};

/**
 * A Pi message as the bridge sees it, tolerant of the Pi 0.x and Pi 1.x
 * message shapes. Pi 1.x adds `role: "system"` messages with string content.
 */
type BridgeMessage = {
  role?: string;
  content?: unknown;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  toolsAdded?: unknown;
  toolsRemoved?: unknown;
  sections?: unknown;
};

/**
 * Normalize a message payload into an array of content blocks, so a string,
 * `null`, or single-object payload can never crash a turn.
 */
export function normalizeContent(content: unknown): BridgeContentBlock[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) {
    return content.filter((item: unknown) => typeof item === "object" && item !== null) as BridgeContentBlock[];
  }
  if (typeof content === "object") return [content as BridgeContentBlock];
  return [];
}

function bridgeMessages(messages: unknown): BridgeMessage[] {
  return Array.isArray(messages) ? (messages as BridgeMessage[]) : [];
}

function isSystemMessage(message: BridgeMessage): boolean {
  return message.role === "system";
}

/**
 * Conversation messages, with the Pi 1.x system messages removed. System
 * messages carry the prompt and the tool declarations, which are rendered as
 * their own prompt sections instead of transcript entries.
 */
export function conversationMessages(messages: unknown): BridgeMessage[] {
  return bridgeMessages(messages).filter((message) => !isSystemMessage(message));
}

/**
 * Tool declarations replayed from the transcript's system messages (Pi 1.x).
 * The leading system message declares the tools; later ones add or remove them.
 */
function transcriptTools(messages: BridgeMessage[]): Tool[] {
  const tools = new Map<string, Tool>();
  for (const message of messages) {
    if (!isSystemMessage(message)) continue;
    for (const removed of (message.toolsRemoved as { name?: unknown }[] | undefined) ?? []) {
      if (removed && typeof removed.name === "string") tools.delete(removed.name);
    }
    for (const added of (message.toolsAdded as Tool[] | undefined) ?? []) {
      if (added && typeof added.name === "string") tools.set(added.name, added);
    }
  }
  return [...tools.values()];
}

/**
 * System prompt replayed from the transcript's system messages (Pi 1.x).
 * Every system message contributes its text; named sections are patched by
 * name (a `null` section removes it) and the surviving sections are appended.
 */
function transcriptSystemPrompt(messages: BridgeMessage[]): string {
  const contents: string[] = [];
  const sections = new Map<string, string>();
  for (const message of messages) {
    if (!isSystemMessage(message)) continue;
    const text = contentToText(message.content);
    if (text.length > 0) contents.push(text);
    const declared = (message.sections ?? {}) as Record<string, unknown>;
    for (const [name, value] of Object.entries(declared)) {
      if (value === null) sections.delete(name);
      else if (typeof value === "string") sections.set(name, value);
    }
  }
  return [...contents, ...sections.values()].filter((part) => part.length > 0).join("\n\n");
}

/**
 * Tools for the current turn. Pi 1.x hands providers a normalized transcript
 * whose system messages carry the tools, leaving `context.tools` empty; Pi 0.x
 * passes them on the context. The transcript wins whenever it has a system message.
 */
export function resolveTurnTools(context: Pick<Context, "messages" | "tools">): Tool[] {
  const messages = bridgeMessages(context?.messages);
  if (messages.some(isSystemMessage)) return transcriptTools(messages);
  return context?.tools ?? [];
}

/** System prompt for the current turn, from the transcript when it has one. */
export function resolveTurnSystemPrompt(context: Pick<Context, "messages" | "systemPrompt">): string {
  const messages = bridgeMessages(context?.messages);
  if (messages.some(isSystemMessage)) return transcriptSystemPrompt(messages);
  return context?.systemPrompt ?? "";
}

function contentToText(content: unknown, imageLabel?: (mimeType: string) => string): string {
  return normalizeContent(content)
    .map((item) => {
      if (item.type === "text") return typeof item.text === "string" ? item.text : "";
      if (item.type === "image") {
        const mimeType = item.mimeType ?? "image";
        if (imageLabel && isAttachableImage(item)) return imageLabel(mimeType);
        const size = typeof item.data === "string" ? item.data.length : 0;
        return `[image omitted: ${mimeType}, ${size} base64 chars]`;
      }
      return "";
    })
    .join("\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function serializeMessage(message: BridgeMessage, imageLabel?: (mimeType: string) => string): string {
  if (message.role === "user") {
    return `USER:\n${contentToText(message.content, imageLabel)}`;
  }

  if (message.role === "toolResult") {
    return [
      `PI TOOL RESULT (${message.toolName}, id=${message.toolCallId}, isError=${message.isError}):`,
      contentToText(message.content, imageLabel),
    ].join("\n");
  }

  const parts = normalizeContent(message.content).map((part) => {
    if (part.type === "text") return typeof part.text === "string" ? part.text : "";
    if (part.type === "thinking") return `<thinking>${part.thinking ?? ""}</thinking>`;
    if (part.type === "toolCall") {
      return `<pi_tool_call>${safeJson({ id: part.id, name: part.name, arguments: part.arguments })}</pi_tool_call>`;
    }
    return "";
  });
  return `ASSISTANT:\n${parts.join("\n")}`;
}

function serializeTools(tools?: Tool[]): string {
  if (!tools || tools.length === 0) return "No Pi tools are available for this turn.";
  return safeJson(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  );
}

/**
 * Every image in the conversation, in transcript order: user attachments and
 * images returned by Pi tools (e.g. `read` on a PNG). `buildPrompt` numbers its
 * image placeholders in the same order.
 */
export function contextImages(context: Pick<Context, "messages">): ImageContent[] {
  return conversationMessages(context.messages).flatMap((message) =>
    message.role === "user" || message.role === "toolResult"
      ? (normalizeContent(message.content).filter(isAttachableImage) as ImageContent[])
      : [],
  );
}

function isAttachableImage(item: BridgeContentBlock): boolean {
  return item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string";
}

export function buildStreamJsonInput(images: ImageContent[], prompt: string): string {
  const content: Array<Record<string, unknown>> = images.map((image) => ({
    type: "image",
    source: { type: "base64", media_type: image.mimeType, data: image.data },
  }));
  content.push({ type: "text", text: prompt });
  return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
}

/**
 * Parse Claude Code's `--output-format json` or `stream-json` output.
 *
 * `json` prints one `result` object, or, when verbose mode is on in the
 * user's Claude Code config, one line holding a JSON array of every event.
 * `stream-json` prints one event per line, ending in `result`.
 *
 * Success is decided by the result's `is_error`, not the exit code:
 * stream-json exits 0 on API errors, and text-mode errors land on stdout.
 */
export function parseClaudeOutput(stdout: string): ClaudeOutput {
  const texts: string[] = [];
  let result: ClaudeResultEvent | undefined;
  let sawJson = false;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let value: any;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    for (const event of Array.isArray(value) ? value : [value]) {
      // Only typed objects are Claude Code events; a plain-text reply may have
      // lines like `42`, `[1, 2]` or `{"debug": true}` that also parse as JSON.
      if (typeof event?.type !== "string") continue;
      sawJson = true;
      if (event.type === "assistant") {
        for (const block of event.message?.content ?? []) {
          if (block?.type === "text" && typeof block.text === "string" && block.text) texts.push(block.text);
        }
      } else if (event.type === "result") {
        result = event;
      }
    }
  }

  if (!result) {
    // No result record: an older CLI printing plain text, or a crash mid-stream
    // (never surface raw stream-json events as the reply).
    return { text: sawJson ? texts.join("\n") : stdout.trim(), isError: false, hasResult: false };
  }

  const resultText = typeof result.result === "string" ? result.result : "";
  const isError = result.is_error === true;
  // An error result without `result` text carries its reason in `errors`;
  // prefer that over a partial reply streamed before the failure.
  const errors =
    isError && Array.isArray(result.errors)
      ? result.errors.filter((error): error is string => typeof error === "string" && error.trim() !== "").join("; ")
      : "";
  const errorText =
    errors && typeof result.subtype === "string" && result.subtype && result.subtype !== "success"
      ? `${result.subtype}: ${errors}`
      : errors;
  const output: ClaudeOutput = {
    text: resultText || errorText || texts.join("\n"),
    isError,
    hasResult: true,
    stopReason: typeof result.stop_reason === "string" ? result.stop_reason : undefined,
    responseModel: answeringModel(result.modelUsage),
  };
  if (result.usage && typeof result.usage === "object") {
    output.usage = {
      input: tokenCount(result.usage.input_tokens),
      output: tokenCount(result.usage.output_tokens),
      cacheRead: tokenCount(result.usage.cache_read_input_tokens),
      cacheWrite: tokenCount(result.usage.cache_creation_input_tokens),
      costTotal: tokenCount(result.total_cost_usd),
    };
  }
  return output;
}

export function buildPrompt(context: Pick<Context, "systemPrompt" | "messages" | "tools">): string {
  const sections: string[] = [];
  sections.push(`# Pi/Claude Code CLI bridge instructions

You are being used as the model backend for Pi Coding Agent through the local Claude Code CLI.
The extension invokes Claude Code strictly with \`claude -p\` for each model turn.
Claude Code's own tools are disabled with \`--tools ""\`; Pi, not Claude Code, executes real file, shell, network, and MCP actions.

If you need Pi to run a tool, output only one or more tool-call blocks and no prose:
<pi_tool_call>{"name":"tool_name","arguments":{}}</pi_tool_call>

Rules for Pi tool calls:
- Use only tools listed in the "Available Pi tools" section.
- The JSON inside <pi_tool_call> must be valid JSON with "name" and "arguments" fields.
- Do not wrap tool calls in Markdown fences.
- If you can answer without a tool, answer normally in plain text.
- After Pi returns tool results, continue from the transcript and either answer or request another Pi tool call.`);

  const systemPrompt = resolveTurnSystemPrompt(context);
  if (systemPrompt.trim()) {
    sections.push(`# Pi system prompt

${systemPrompt}`);
  }

  sections.push(`# Available Pi tools

${serializeTools(resolveTurnTools(context))}`);

  // Images are attached to the request in this same order (see contextImages).
  let imageNumber = 0;
  const imageLabel = (mimeType: string) => `[image ${++imageNumber} (${mimeType}): attached to this request]`;
  const conversation = conversationMessages(context.messages);
  if (conversation.length > 0) {
    sections.push(`# Conversation transcript

${conversation.map((message) => serializeMessage(message, imageLabel)).join("\n\n---\n\n")}`);
  } else {
    sections.push("# Conversation transcript\n\n(no prior messages)");
  }

  sections.push("Now produce the next assistant message for Pi.");
  return sections.join("\n\n---\n\n");
}

function parseToolCalls(text: string): { calls: Array<{ name: string; arguments: Record<string, any> }>; invalid: string[] } {
  const tagRegex = /<pi_tool_call>([\s\S]*?)<\/pi_tool_call>/g;
  const matches = [...text.trim().matchAll(tagRegex)];
  const calls: Array<{ name: string; arguments: Record<string, any> }> = [];
  const invalid: string[] = [];
  for (const match of matches) {
    const parsed = parseToolCallJson(match[1] ?? "");
    if (parsed.length > 0) calls.push(...parsed);
    else invalid.push(match[0]);
  }
  return { calls, invalid };
}

function parseToolCallJson(raw: string): Array<{ name: string; arguments: Record<string, any> }> {
  let value: any;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    return [];
  }

  const candidates = Array.isArray(value)
    ? value
    : Array.isArray(value?.tool_calls)
      ? value.tool_calls
      : [value];
  const calls: Array<{ name: string; arguments: Record<string, any> }> = [];
  for (const candidate of candidates) {
    const name =
      typeof candidate?.name === "string"
        ? candidate.name
        : typeof candidate?.tool === "string"
          ? candidate.tool
          : undefined;
    const args = candidate?.arguments ?? candidate?.args ?? candidate?.input ?? {};
    if (!name || typeof args !== "object" || args === null || Array.isArray(args)) continue;
    calls.push({ name, arguments: args });
  }
  return calls;
}

type CliStatus = {
  ok: boolean;
  summary: string;
  detail?: string;
};

/** The claude executable could not be started (missing, not executable, ...). */
class CliSpawnError extends Error {}

function setupGuidance(error: string): string {
  // Same check as claudeBin(): a blank override falls back to `claude` on PATH.
  // claudeBin() reads the variable on every spawn, so a repaired executable works
  // at once; a new value or unsetting it needs a restart, since /reload keeps
  // Pi's environment.
  const fix = process.env.CLAUDE_CODE_PI_BIN?.trim()
    ? "Repair the executable CLAUDE_CODE_PI_BIN points to, or change or unset CLAUDE_CODE_PI_BIN and restart Pi."
    : "Install Claude Code, ensure `claude --version` works on PATH, authenticate Claude Code if needed, then /reload. Set CLAUDE_CODE_PI_BIN to override the executable path.";
  return [
    "claude-code-pi: could not use the local Claude Code CLI.",
    `Reason: ${error.trim().replace(/\.$/, "")}.`,
    fix,
    "This provider never falls back to Anthropic SDK, HTTP APIs, or Pi built-in Claude providers; every request must go through `claude -p`.",
  ].join(" ");
}

function runCapture(
  args: string[],
  input?: string,
  timeoutMs = STATUS_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin(), args, {
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`claude timed out after ${timeoutMs}ms`));
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

    if (input !== undefined) child.stdin!.end(input);
  });
}

// On POSIX each turn's `claude` leads its own process group, so abort and
// timeout also reach what a wrapper script or the CLI itself started.
const turnGroups = new Set<ChildProcess>();

function signalTurn(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group is already gone.
    }
  }
  child.kill(signal);
}

function killTurnGroups(): void {
  for (const child of turnGroups) signalTurn(child, "SIGKILL");
}

// The detached group no longer gets the terminal's Ctrl+C, and `pi -p` has no
// SIGINT handler, so kill the group and re-raise. Pi's other exits go through
// process.exit, which runs the exit hook.
function interruptTurns(): void {
  killTurnGroups();
  for (const child of [...turnGroups]) untrackTurn(child);
  if (process.listenerCount("SIGINT") === 0) process.kill(process.pid, "SIGINT");
}

function trackTurn(child: ChildProcess): void {
  if (turnGroups.size === 0) {
    process.on("exit", killTurnGroups);
    process.prependListener("SIGINT", interruptTurns);
  }
  turnGroups.add(child);
}

function untrackTurn(child: ChildProcess): void {
  if (!turnGroups.delete(child) || turnGroups.size > 0) return;
  process.off("exit", killTurnGroups);
  process.off("SIGINT", interruptTurns);
}

async function checkCliStatus(): Promise<CliStatus> {
  try {
    const result = await runCapture(["--version"]);
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `claude --version exited with code ${result.code}`;
      return { ok: false, summary: "Claude Code CLI is unusable", detail };
    }
    const version = result.stdout.trim() || result.stderr.trim() || "claude is available";
    return { ok: true, summary: version };
  } catch (error) {
    return {
      ok: false,
      summary: "Claude Code CLI is unavailable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function streamClaudeCode(
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
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      stream.push({ type: "start", partial: output });
      if (options?.signal?.aborted) throw new Error("Request was aborted");

      const prompt = buildPrompt(context);
      const images = contextImages(context);
      const useStreamJson = images.length > 0;
      const reasoning = options?.reasoning as ModelThinkingLevel | "max" | undefined;
      const detached = process.platform !== "win32";
      const child = spawn(claudeBin(), buildClaudeArgs(model.id, reasoning, useStreamJson), {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
        detached,
      });
      if (detached && child.pid) trackTurn(child);
      child.on("close", () => untrackTurn(child));

      // Processes left in the group can hold the pipes open long after the
      // killed child exits, so the turn ends now instead of on 'close'.
      let endTurn = () => {};
      const abort = () => {
        signalTurn(child, "SIGTERM");
        const escalate = setTimeout(() => {
          signalTurn(child, "SIGKILL");
          untrackTurn(child);
        }, KILL_GRACE_MS);
        escalate.unref();
        child.on("close", () => clearTimeout(escalate));
        endTurn();
      };
      const timeout = requestTimeoutMs();
      timer = setTimeout(() => {
        timedOut = true;
        abort();
      }, timeout);
      options?.signal?.addEventListener("abort", abort, { once: true });

      // If claude exits before reading a large prompt, the write fails with
      // EPIPE; the exit code and stderr already report the real failure.
      child.stdin!.on("error", () => {});
      child.stdin!.end(useStreamJson ? buildStreamJsonInput(images, prompt) : prompt);
      child.stdout!.setEncoding("utf8");
      child.stderr!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr!.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_LIMIT);
      });

      const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.on("error", (error) => reject(new CliSpawnError(error.message)));
        child.on("close", (code, signal) => resolve({ code, signal }));
        endTurn = () => resolve({ code: null, signal: "SIGTERM" });
      });
      settled = true;
      if (timer) clearTimeout(timer);
      options?.signal?.removeEventListener("abort", abort);

      if (options?.signal?.aborted) throw new Error("Request was aborted");
      if (timedOut) throw new Error(`claude -p timed out after ${timeout}ms`);

      const parsed = parseClaudeOutput(stdout);
      // A failed turn is still billed: keep the usage its result record reports.
      if (parsed.responseModel) output.responseModel = parsed.responseModel;
      if (parsed.usage) applyClaudeUsage(output, parsed.usage);
      if (parsed.isError) throw new Error(parsed.text.trim() || stderr.trim() || "claude -p reported an error");
      if (code !== 0) {
        throw new Error(
          (parsed.hasResult ? parsed.text.trim() : "") ||
            stderr.trim() ||
            // Plain-text errors from an older CLI only; never raw or cut-off JSON events
            // (one per line, or a verbose json array of them).
            (/^[{[]/.test(stdout.trimStart()) ? "" : stdout.trim()) ||
            (code === null && signal ? `claude -p was killed by ${signal}` : `claude -p exited with code ${code}`),
        );
      }
      // Exit 0 with no result record and no reply text is a broken run, not a blank answer.
      if (!parsed.hasResult && !parsed.text.trim()) {
        throw new Error(`claude -p returned no output (exit 0)${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
      }

      if (!parsed.usage) setEstimatedUsage(model, output, prompt, stdout);
      const responseText = parsed.text;
      const { calls: toolCalls, invalid } = parseToolCalls(responseText);
      if (toolCalls.length > 0) {
        output.stopReason = "toolUse";
        // Say which markers were not run, so the user and the next turn see them.
        if (invalid.length > 0) {
          const note = invalid
            .map((raw) => `claude-code-pi: did not run this invalid tool call (needs valid JSON with "name" and "arguments"): ${raw}`)
            .join("\n");
          const noteIndex = output.content.length;
          output.content.push({ type: "text", text: note });
          stream.push({ type: "text_start", contentIndex: noteIndex, partial: output });
          stream.push({ type: "text_delta", contentIndex: noteIndex, delta: note, partial: output });
          stream.push({ type: "text_end", contentIndex: noteIndex, content: note, partial: output });
        }
        for (const call of toolCalls) {
          const toolCall: ToolCall = {
            type: "toolCall",
            id: `claude_code_pi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: call.name,
            arguments: call.arguments,
          };
          const toolIndex = output.content.length;
          output.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex: toolIndex, partial: output });
          stream.push({ type: "toolcall_delta", contentIndex: toolIndex, delta: safeJson(toolCall.arguments), partial: output });
          stream.push({ type: "toolcall_end", contentIndex: toolIndex, toolCall, partial: output });
        }
        stream.push({ type: "done", reason: "toolUse", message: output });
        stream.end();
        return;
      }

      const contentIndex = output.content.length;
      output.content.push({ type: "text", text: responseText });
      stream.push({ type: "text_start", contentIndex, partial: output });
      if (responseText) {
        stream.push({ type: "text_delta", contentIndex, delta: responseText, partial: output });
      }
      stream.push({ type: "text_end", contentIndex, content: responseText, partial: output });
      const reason = parsed.stopReason === "max_tokens" ? "length" : "stop";
      output.stopReason = reason;
      stream.push({ type: "done", reason, message: output });
      stream.end();
    } catch (error) {
      if (timer && !settled) clearTimeout(timer);
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      const message = error instanceof Error ? error.message : String(error);
      // Install/PATH guidance only helps when the binary could not start; API,
      // auth, and model errors are shown as Claude Code reported them.
      output.errorMessage = error instanceof CliSpawnError ? setupGuidance(message) : `claude-code-pi: ${message}`;
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

function providerModels() {
  return registeredModels.map((model) => ({
    id: model.id,
    name: `${model.name} (Claude Code CLI)`,
    reasoning: model.reasoning,
    input: ["text", "image"] as ("text" | "image")[],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    // Cost is taken per turn from Claude Code's own `total_cost_usd`.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Pi 0.75's map type has no `max` key; Pi 1.x needs it to offer `max`.
    thinkingLevelMap: { ...EFFORT_BY_LEVEL } as Record<string, string>,
  }));
}

function registerClaudeProvider(pi: ExtensionAPI) {
  pi.registerProvider(PROVIDER_ID, {
    name: "Claude Code CLI",
    baseUrl: "cli:claude-p",
    apiKey: "claude-code-cli-no-api-key",
    api: API_ID,
    models: providerModels(),
    streamSimple: streamClaudeCode,
  });
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
    `Claude Code CLI: ${panelCliState()}`,
    "Transport: local claude -p (no API fallback)",
    "Authentication: delegated to Claude Code CLI (contents not inspected)",
    `Registered models: ${registeredModels.length}`,
  ];
}

function panelConfigurationLines(): string[] {
  return [
    `CLAUDE_CODE_PI_BIN: ${panelEnvState("CLAUDE_CODE_PI_BIN")}`,
    `CLAUDE_CODE_PI_MODELS: ${panelEnvState("CLAUDE_CODE_PI_MODELS")}`,
    `CLAUDE_CODE_PI_TIMEOUT_MS: ${panelEnvState("CLAUDE_CODE_PI_TIMEOUT_MS")}`,
    `CLAUDE_CODE_PI_CONTEXT_WINDOW: ${panelEnvState("CLAUDE_CODE_PI_CONTEXT_WINDOW")}`,
    "Credentials: managed externally by Claude Code CLI (contents not read)",
  ];
}

function panelModelLines(): string[] {
  return [
    `Registered models: ${registeredModels.length}`,
    "Availability: registered in the Pi provider; CLI model availability not checked",
    "Registered count does not prove that the CLI can serve every model.",
  ];
}

function panelHelpLines(): string[] {
  return [
    "Read-only view: no refresh, update, test, login, model calls, or configuration edits.",
    "Use Up/Down to navigate and Enter to inspect a section.",
    "Use Back to return to the sections, or Close/Escape to leave the panel.",
    "Explicit /claude-code-pi status, models, test, and help commands are unchanged.",
  ];
}

export async function showClaudePanelList(ctx: any, title: string, lines: string[]): Promise<string | undefined> {
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
      CLAUDE_PANEL_BACK,
      CLAUDE_PANEL_CLOSE,
    ];
    const counter = ` (${page + 1}/${records.length})`;
    let heading = title;
    if (heading.length + counter.length > 38) heading = heading.replace(/\s+\([^()]*\)$/u, "");
    if (heading.length + counter.length > 38) heading = heading.slice(0, Math.min(30, 38 - counter.length));
    const choice = await ctx.ui.select(`${heading}${counter}`, options);
    if (choice === undefined || choice === CLAUDE_PANEL_CLOSE || choice === CLAUDE_PANEL_BACK) return choice;
    if (choice === "Previous" && page > 0) page -= 1;
    if (choice === "Next" && page < records.length - 1) page += 1;
  }
}

async function showClaudePanel(ctx: any): Promise<void> {
  while (true) {
    const choice = await ctx.ui.select("claude-code-pi (read-only)", [
      CLAUDE_PANEL_STATUS,
      CLAUDE_PANEL_CONFIG,
      CLAUDE_PANEL_MODELS,
      CLAUDE_PANEL_HELP,
      CLAUDE_PANEL_CLOSE,
    ]);
    if (choice === undefined || choice === CLAUDE_PANEL_CLOSE) return;

    if (choice === CLAUDE_PANEL_STATUS) {
      const detailChoice = await showClaudePanelList(ctx, "claude-code-pi provider status", panelProviderStatusLines());
      if (detailChoice === undefined || detailChoice === CLAUDE_PANEL_CLOSE) return;
      continue;
    }
    if (choice === CLAUDE_PANEL_CONFIG) {
      const detailChoice = await showClaudePanelList(ctx, "claude-code-pi configuration (source presence)", panelConfigurationLines());
      if (detailChoice === undefined || detailChoice === CLAUDE_PANEL_CLOSE) return;
      continue;
    }
    if (choice === CLAUDE_PANEL_MODELS) {
      const detailChoice = await showClaudePanelList(ctx, "claude-code-pi models (registered)", panelModelLines());
      if (detailChoice === undefined || detailChoice === CLAUDE_PANEL_CLOSE) return;
      continue;
    }
    if (choice === CLAUDE_PANEL_HELP) {
      const detailChoice = await showClaudePanelList(ctx, "claude-code-pi help / navigation", panelHelpLines());
      if (detailChoice === undefined || detailChoice === CLAUDE_PANEL_CLOSE) return;
      continue;
    }

    return;
  }
}

function statusLines(status?: CliStatus): string[] {
  const lines = [
    `Provider: ${PROVIDER_ID}`,
    `Claude binary: ${claudeBin()}`,
    "Transport: strictly local `claude -p` per model turn",
    "Fallbacks: none (no Anthropic SDK, HTTP API, or built-in Claude provider)",
    'Own Claude Code tools: disabled via --tools "" --strict-mcp-config --disable-slash-commands',
    "Thinking: --effort mapped from Pi thinking levels (minimal→low … max)",
    "Usage: token counts, cost, and resolved model reported by Claude Code",
    "Images: sent as base64 blocks via --input-format stream-json",
    `Registered models: ${registeredModels.length}`,
  ];

  const current = status ?? lastCliStatus;
  if (current) {
    lines.push(`CLI status: ${current.ok ? "ok" : "error"} — ${current.summary}`);
    if (current.detail) lines.push(`CLI detail: ${current.detail}`);
  } else {
    lines.push("CLI status: run /claude-code-pi status to check `claude --version`.");
  }

  lines.push("");
  for (const model of registeredModels) lines.push(`  - ${PROVIDER_ID}/${model.id} — ${model.name}`);
  lines.push("");
  lines.push("Quick test:");
  lines.push(`  pi -p --provider ${PROVIDER_ID} --model ${registeredModels[0]?.id ?? "sonnet"} "Reply with exactly OK"`);
  lines.push("Claude Code smoke test:");
  lines.push(`  ${shellQuote(claudeBin())} -p --model ${registeredModels[0]?.id ?? "sonnet"} --no-session-persistence --tools "" --strict-mcp-config --disable-slash-commands "Reply with exactly OK"`);
  return lines;
}

export default function claudeCodePiExtension(pi: ExtensionAPI) {
  registeredModels = configuredModels(process.env.CLAUDE_CODE_PI_MODELS);
  registerClaudeProvider(pi);

  pi.on("session_start", async (_event: any, ctx: any) => {
    for (const envWarning of [timeoutEnvWarning(), contextWindowEnvWarning()]) {
      if (!envWarning) continue;
      ctx.ui.notify(envWarning, "warning");
      // pi -p has no UI (notify is a no-op); warn on stderr without failing the run.
      if (!ctx.hasUI) console.error(envWarning);
    }
    lastCliStatus = await checkCliStatus();
    if (!lastCliStatus.ok) {
      ctx.ui.notify(setupGuidance(lastCliStatus.detail ?? lastCliStatus.summary), "warning");
      return;
    }
    ctx.ui.notify(
      `claude-code-pi: registered ${registeredModels.length} Claude Code CLI model(s). Use /model and pick ${PROVIDER_ID}.`,
      "info",
    );
  });

  pi.registerCommand("claude-code-pi", {
    description: "Claude Code CLI provider status and setup help",
    handler: async (args: string, ctx: any) => {
      const trimmedArgs = args.trim();
      if (trimmedArgs.length === 0 && ctx.mode === "tui" && ctx.hasUI) {
        await showClaudePanel(ctx);
        return;
      }

      const report = (message: string, level: "info" | "warning") => {
        ctx.ui.notify(message, level);
        if (ctx.hasUI) return;
        // pi -p / --mode json have no UI (notify is a no-op); Pi sends console output to stderr there.
        if (level === "warning") {
          console.error(message);
          process.exitCode = 1;
        } else {
          console.log(message);
        }
      };

      const sub = trimmedArgs.split(/\s+/).filter(Boolean)[0] ?? "status";
      if (sub === "status") {
        lastCliStatus = await checkCliStatus();
        // One notice per command: Pi 1.x replaces consecutive info notices in the TUI.
        report(statusLines(lastCliStatus).join("\n"), lastCliStatus.ok ? "info" : "warning");
        return;
      }
      if (sub === "models") {
        const lines = registeredModels.map((model) => `${PROVIDER_ID}/${model.id} — ${model.name}`);
        lines.push('Override with CLAUDE_CODE_PI_MODELS="sonnet,opus,fable,haiku"');
        report(lines.join("\n"), "info");
        return;
      }
      if (sub === "test") {
        report(
          [
            `Run: pi -p --provider ${PROVIDER_ID} --model ${registeredModels[0]?.id ?? "sonnet"} "Reply with exactly OK"`,
            `Strict transport check: ${shellQuote(claudeBin())} -p --model ${registeredModels[0]?.id ?? "sonnet"} --no-session-persistence --tools "" --strict-mcp-config --disable-slash-commands "Reply with exactly OK"`,
          ].join("\n"),
          "info",
        );
        return;
      }
      if (sub === "help") {
        report(
          [
            "Usage: /claude-code-pi [status|models|test|help]",
            "Set CLAUDE_CODE_PI_BIN to override the claude executable.",
            "Set CLAUDE_CODE_PI_MODELS for comma- or space-separated Claude Code model aliases.",
            "Set CLAUDE_CODE_PI_TIMEOUT_MS to override the per-turn `claude -p` timeout in milliseconds (default 300000).",
            "Set CLAUDE_CODE_PI_CONTEXT_WINDOW to override the advertised context window (default 1000000).",
            "Thinking levels map to `claude -p --effort` (minimal/low→low, medium, high, xhigh, max).",
            "Image inputs are sent as base64 blocks via --input-format stream-json.",
            "All provider calls spawn local `claude -p`; there is no API fallback.",
          ].join("\n"),
          "info",
        );
        return;
      }
      report(`Unknown /claude-code-pi subcommand: ${sub}. Try /claude-code-pi help`, "warning");
    },
  });
}
