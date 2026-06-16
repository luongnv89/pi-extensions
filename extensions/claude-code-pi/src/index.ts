import { spawn } from "node:child_process";
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
  type SimpleStreamOptions,
  type TextContent,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";

export const PROVIDER_ID = "claude-code-cli";
const API_ID = "claude-code-cli-runner";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 16_384;
const STATUS_TIMEOUT_MS = 4_000;
const REQUEST_TIMEOUT_MS = 5 * 60_000;
const STDERR_LIMIT = 20_000;

export type ClaudeCodeModelInfo = {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
};

const DEFAULT_MODELS: ClaudeCodeModelInfo[] = [
  {
    id: "sonnet",
    name: "Claude Code Sonnet alias",
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    reasoning: true,
  },
  {
    id: "opus",
    name: "Claude Code Opus alias",
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    reasoning: true,
  },
  {
    id: "fable",
    name: "Claude Code Fable alias",
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    reasoning: true,
  },
];

let registeredModels: ClaudeCodeModelInfo[] = configuredModels(process.env.CLAUDE_CODE_PI_MODELS);
let lastCliStatus: CliStatus | undefined;

function claudeBin(): string {
  return process.env.CLAUDE_CODE_PI_BIN?.trim() || "claude";
}

function requestTimeoutMs(): number {
  const configured = Number(process.env.CLAUDE_CODE_PI_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return REQUEST_TIMEOUT_MS;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

export function configuredModels(raw: string | undefined): ClaudeCodeModelInfo[] {
  const configured = raw
    ?.split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const ids = configured && configured.length > 0 ? dedupe(configured) : DEFAULT_MODELS.map((model) => model.id);
  const defaults = new Map(DEFAULT_MODELS.map((model) => [model.id, model]));

  return ids.map((id) => {
    const known = defaults.get(id);
    if (known) return known;
    return {
      id,
      name: `Claude Code ${id}`,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
      reasoning: true,
    };
  });
}

export function buildClaudeArgs(modelId: string): string[] {
  return [
    "-p",
    "--model",
    modelId,
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    "--tools",
    "",
    "--output-format",
    "text",
  ];
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

function contentToText(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  return content
    .map((item) => {
      if (item.type === "text") return item.text;
      return `[image omitted: ${item.mimeType}, ${item.data.length} base64 chars]`;
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

  const parts = message.content.map((part: TextContent | ToolCall | { type: "thinking"; thinking: string }) => {
    if (part.type === "text") return part.text;
    if (part.type === "thinking") return `<thinking>${part.thinking}</thinking>`;
    return `<pi_tool_call>${safeJson({ name: part.name, arguments: part.arguments })}</pi_tool_call>`;
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

function parseToolCalls(text: string): Array<{ name: string; arguments: Record<string, any> }> {
  const tagRegex = /<pi_tool_call>([\s\S]*?)<\/pi_tool_call>/g;
  const matches = [...text.trim().matchAll(tagRegex)];
  return matches.flatMap((match) => parseToolCallJson(match[1] ?? ""));
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

function setupGuidance(error: string): string {
  return [
    "claude-code-pi could not use the local Claude Code CLI.",
    `Reason: ${error}`,
    "Install Claude Code, ensure `claude --version` works on PATH, authenticate Claude Code if needed, then reload Pi.",
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

    const prompt = buildPrompt(context);
    let stderr = "";
    let stdout = "";
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      stream.push({ type: "start", partial: output });
      const child = spawn(claudeBin(), buildClaudeArgs(model.id), {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      const abort = () => child.kill("SIGTERM");
      const timeout = requestTimeoutMs();
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeout);
      options?.signal?.addEventListener("abort", abort, { once: true });

      child.stdin!.end(prompt);
      child.stdout!.setEncoding("utf8");
      child.stderr!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr!.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_LIMIT);
      });

      const code = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      settled = true;
      if (timer) clearTimeout(timer);
      options?.signal?.removeEventListener("abort", abort);

      if (options?.signal?.aborted) throw new Error("Request was aborted");
      if (timedOut) throw new Error(`claude -p timed out after ${timeout}ms`);
      if (code !== 0) throw new Error(stderr.trim() || `claude -p exited with code ${code}`);

      setEstimatedUsage(model, output, prompt, stdout);
      const toolCalls = parseToolCalls(stdout);
      if (toolCalls.length > 0) {
        output.stopReason = "toolUse";
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
      output.content.push({ type: "text", text: stdout });
      stream.push({ type: "text_start", contentIndex, partial: output });
      if (stdout) {
        stream.push({ type: "text_delta", contentIndex, delta: stdout, partial: output });
      }
      stream.push({ type: "text_end", contentIndex, content: stdout, partial: output });
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      if (timer && !settled) clearTimeout(timer);
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = setupGuidance(error instanceof Error ? error.message : String(error));
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
    input: ["text"] as ("text" | "image")[],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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

function statusLines(status?: CliStatus): string[] {
  const lines = [
    `Provider: ${PROVIDER_ID}`,
    `Claude binary: ${claudeBin()}`,
    "Transport: strictly local `claude -p` per model turn",
    "Fallbacks: none (no Anthropic SDK, HTTP API, or built-in Claude provider)",
    'Own Claude Code tools: disabled via --tools ""',
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
  lines.push(`  ${claudeBin()} -p --model ${registeredModels[0]?.id ?? "sonnet"} --no-session-persistence --tools "" "Reply with exactly OK"`);
  return lines;
}

export default function claudeCodePiExtension(pi: ExtensionAPI) {
  registeredModels = configuredModels(process.env.CLAUDE_CODE_PI_MODELS);
  registerClaudeProvider(pi);

  pi.on("session_start", async (_event: any, ctx: any) => {
    lastCliStatus = await checkCliStatus();
    if (!lastCliStatus.ok) {
      ctx.ui.notify(`claude-code-pi: ${setupGuidance(lastCliStatus.detail ?? lastCliStatus.summary)}`, "warning");
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
      const sub = args.trim().split(/\s+/).filter(Boolean)[0] ?? "status";
      if (sub === "status") {
        lastCliStatus = await checkCliStatus();
        for (const line of statusLines(lastCliStatus)) ctx.ui.notify(line, lastCliStatus.ok ? "info" : "warning");
        return;
      }
      if (sub === "models") {
        for (const model of registeredModels) ctx.ui.notify(`${PROVIDER_ID}/${model.id} — ${model.name}`, "info");
        ctx.ui.notify('Override with CLAUDE_CODE_PI_MODELS="sonnet,opus,fable"', "info");
        return;
      }
      if (sub === "test") {
        ctx.ui.notify(
          `Run: pi -p --provider ${PROVIDER_ID} --model ${registeredModels[0]?.id ?? "sonnet"} "Reply with exactly OK"`,
          "info",
        );
        ctx.ui.notify(
          `Strict transport check: ${claudeBin()} -p --model ${registeredModels[0]?.id ?? "sonnet"} --no-session-persistence --tools "" "Reply with exactly OK"`,
          "info",
        );
        return;
      }
      if (sub === "help") {
        ctx.ui.notify("Usage: /claude-code-pi [status|models|test|help]", "info");
        ctx.ui.notify("Set CLAUDE_CODE_PI_BIN to override the claude executable.", "info");
        ctx.ui.notify("Set CLAUDE_CODE_PI_MODELS for comma-separated Claude Code model aliases.", "info");
        ctx.ui.notify("All provider calls spawn local `claude -p`; there is no API fallback.", "info");
        return;
      }
      ctx.ui.notify(`Unknown /claude-code-pi subcommand: ${sub}. Try /claude-code-pi help`, "warning");
    },
  });
}
