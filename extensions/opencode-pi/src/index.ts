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
  type SimpleStreamOptions,
  type TextContent,
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

let registeredModels: string[] = [];
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
  models: string[];
  time: number;
  error: string | undefined;
}> {
  const configured = configuredModels();
  if (configured?.length) {
    lastDiscoveryError = undefined;
    return { models: dedupe(configured), time: Date.now(), error: undefined };
  }

  try {
    const result = await runCapture(["models", "opencode"]);
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() ||
          `opencode models exited with code ${result.code}`,
      );
    }
    const discovered = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("opencode/"))
      .filter(looksFree);
    lastDiscoveryError = undefined;
    return {
      models: dedupe(discovered.length > 0 ? discovered : DEFAULT_FREE_MODELS),
      time: Date.now(),
      error: undefined,
    };
  } catch (error) {
    lastDiscoveryError = error instanceof Error ? error.message : String(error);
    return {
      models: DEFAULT_FREE_MODELS,
      time: Date.now(),
      error: lastDiscoveryError,
    };
  }
}

async function refreshModels(
  pi: ExtensionAPI,
  ctx: { ui: { notify: (msg: string, level?: string) => void } },
): Promise<void> {
  const previousModels = new Set(registeredModels);
  const { models, time, error } = await discoverModels();
  registeredModels = models;
  lastDiscoveryTime = time;

  // Re-register the provider with the updated model list
  const providerConfig: Parameters<ExtensionAPI["registerProvider"]>[1] = {
    name: "OpenCode CLI",
    baseUrl: "cli:opencode",
    apiKey: "opencode-cli-no-api-key",
    api: API_ID,
    models: models.map((model) => ({
      id: model,
      name: `${modelDisplayName(model)} (OpenCode CLI)`,
      reasoning: false,
      input: ["text"] as const,
      contextWindow: contextWindowFor(model),
      maxTokens: maxTokensFor(model),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    streamSimple: streamOpenCode,
  };

  try {
    pi.registerProvider(PROVIDER_ID, providerConfig);
  } catch {
    // registerProvider may reject if already registered; the models array is already updated.
  }

  const newModels = models.filter((m) => !previousModels.has(m));

  let msg = `opencode-pi: refreshed ${models.length} model(s).`;
  if (newModels.length > 0) {
    msg += ` ${newModels.length} new: ${newModels.slice(0, 5).join(", ")}${newModels.length > 5 ? ", ..." : ""}`;
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

  const parts = message.content.map(
    (part: TextContent | ToolCall | { type: "thinking"; thinking: string }) => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking")
        return `<thinking>${part.thinking}</thinking>`;
      return `<pi_tool_call>${safeJson({ name: part.name, arguments: part.arguments })}</pi_tool_call>`;
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

function parseToolCalls(
  text: string,
): Array<{ name: string; arguments: Record<string, any> }> {
  const trimmed = text.trim();
  const tagRegex = /<pi_tool_call>([\s\S]*?)<\/pi_tool_call>/g;
  const matches = [...trimmed.matchAll(tagRegex)];
  if (matches.length > 0) {
    // Some models prepend a sentence like "Let me check that" before the marker.
    // Treat any valid marker as the assistant's intended Pi tool call and drop prose
    // so Pi receives structured tool calls instead of raw marker text.
    return matches.flatMap((match) => parseToolCallJson(match[1] ?? ""));
  }
  return parseToolCallJson(trimmed);
}

function parseToolCallJson(
  raw: string,
): Array<{ name: string; arguments: Record<string, any> }> {
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
    const args =
      candidate?.arguments ?? candidate?.args ?? candidate?.input ?? {};
    if (
      !name ||
      typeof args !== "object" ||
      args === null ||
      Array.isArray(args)
    )
      continue;
    calls.push({ name, arguments: args });
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
description: Text-only Pi bridge agent. OpenCode tools are denied; Pi tool calls are emitted as text markers.
mode: primary
permission:
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
    let stderr = "";
    let stdoutRemainder = "";
    let opencodeToolUse: string | undefined;
    const prompt = buildPrompt(context);

    try {
      stream.push({ type: "start", partial: output });
      tempDir = await createTempAgentDir();
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
      const child = spawn(opencodeBin(), args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, OPENCODE_DISABLE_UPDATE_CHECK: "1" },
      });

      const abort = () => child.kill("SIGTERM");
      options?.signal?.addEventListener("abort", abort, { once: true });

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

        if (event.type === "step_finish" && event.part?.tokens) {
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
          stderr = (stderr + `\n${safeJson(event)}`).slice(-STDERR_LIMIT);
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
      if (stdoutRemainder.trim()) handleLine(stdoutRemainder);

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (code !== 0) {
        throw new Error(stderr.trim() || `opencode exited with code ${code}`);
      }
      if (opencodeToolUse) {
        throw new Error(
          `OpenCode attempted to use its own tool (${opencodeToolUse}). opencode-pi disables OpenCode tools; use Pi tool-call markers only.`,
        );
      }

      const toolCalls = parseToolCalls(accumulatedText);
      setEstimatedUsage(model, output, prompt, accumulatedText);

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
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage =
        error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    } finally {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
  })();

  return stream;
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
  for (const model of registeredModels)
    lines.push(`  - ${PROVIDER_ID}/${model}`);
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
    models: registeredModels.map((model) => ({
      id: model,
      name: `${modelDisplayName(model)} (OpenCode CLI)`,
      reasoning: false,
      input: ["text"],
      contextWindow: contextWindowFor(model),
      maxTokens: maxTokensFor(model),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
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
          ctx.ui.notify(`${PROVIDER_ID}/${model}`, "info");
        ctx.ui.notify(
          `Override with OPENCODE_PI_MODELS="opencode/model-a,opencode/model-b"`,
          "info",
        );
        return;
      }
      if (sub === "test") {
        ctx.ui.notify(
          `Run: pi -p --provider ${PROVIDER_ID} --model ${registeredModels[0] ?? DEFAULT_FREE_MODELS[0]} "Reply with exactly OK"`,
          "info",
        );
        ctx.ui.notify(
          `OpenCode check: ${opencodeBin()} run -m ${registeredModels[0] ?? DEFAULT_FREE_MODELS[0]} --format json "Reply OK"`,
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
