import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  calculateCost,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Message,
  type Model,
  type ModelThinkingLevel,
  type SimpleStreamOptions,
  type TextContent,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";

export const PROVIDER_ID = "cursor-cli";
const API_ID = "cursor-cli-runner";
const DEFAULT_CONTEXT_WINDOW = 272_000;
const DEFAULT_MAX_TOKENS = 16_384;
const STATUS_TIMEOUT_MS = 8_000;
const REQUEST_TIMEOUT_MS = 5 * 60_000;
const STDERR_LIMIT = 20_000;

export const INSTALL_GUIDANCE =
  "Install the Cursor CLI with: curl https://cursor.com/install | sh — then run `cursor-agent login` and reload Pi.";

export type CursorModelInfo = {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
};

const DEFAULT_MODELS: CursorModelInfo[] = [
  { id: "auto", name: "Cursor Auto", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS, reasoning: true },
  { id: "composer-2.5", name: "Composer 2.5", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS, reasoning: true },
  { id: "gpt-5.3-codex-high", name: "Codex 5.3 High", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS, reasoning: true },
  { id: "claude-sonnet-5-thinking-xhigh", name: "Claude Sonnet 5 Thinking", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS, reasoning: true },
  { id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS, reasoning: true },
];

let registeredModels: CursorModelInfo[] = configuredModels(process.env.CURSOR_PI_MODELS);
let lastCliStatus: CliStatus | undefined;

function cursorBin(): string {
  return process.env.CURSOR_PI_BIN?.trim() || "cursor-agent";
}

function requestTimeoutMs(): number {
  const configured = Number(process.env.CURSOR_PI_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return REQUEST_TIMEOUT_MS;
}

function contextWindowOverride(): number | undefined {
  const configured = Number(process.env.CURSOR_PI_CONTEXT_WINDOW);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  return undefined;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

export function configuredModels(raw: string | undefined): CursorModelInfo[] {
  const configured = raw
    ?.split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const ids = configured && configured.length > 0 ? dedupe(configured) : DEFAULT_MODELS.map((model) => model.id);
  const defaults = new Map(DEFAULT_MODELS.map((model) => [model.id, model]));
  const contextWindow = contextWindowOverride();

  return ids.map((id) => {
    const known = defaults.get(id);
    if (known && !contextWindow) return known;
    return {
      id,
      name: known?.name ?? `Cursor ${id}`,
      contextWindow: contextWindow ?? known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: known?.maxTokens ?? DEFAULT_MAX_TOKENS,
      reasoning: true,
    };
  });
}

export function buildCursorArgs(modelId: string): string[] {
  return [
    "-p",
    "--output-format",
    "text",
    "--model",
    modelId,
    // Read-only Q&A mode keeps Cursor's own tools from editing files or running
    // shell commands; Pi tools are prompt-bridged via <pi_tool_call> markers.
    "--mode",
    "ask",
    // Non-interactive: skip the workspace-trust prompt (ask mode is read-only).
    "--trust",
  ];
}

/**
 * Parse `cursor-agent models` output. Lines look like:
 *   auto - Auto (current, default)
 *   gpt-5.3-codex-high - Codex 5.3 High
 */
export function parseModelsList(stdout: string): Array<{ id: string; name: string }> {
  const models: Array<{ id: string; name: string }> = [];
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^([A-Za-z0-9._[\]=,:/-]+)\s+-\s+(.+)$/);
    if (!match) continue;
    models.push({ id: match[1]!, name: match[2]!.trim() });
  }
  return models;
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
  if ((model as any)?.cost) calculateCost(model, output.usage);
}

function contentToText(content: string | (TextContent | any)[]): string {
  if (typeof content === "string") return content;
  return content
    .map((item) => {
      if (item.type === "text") return item.text;
      if (item.type === "image") return `[image omitted: ${item.mimeType}]`;
      return `[${item.type} omitted]`;
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

  const parts = message.content.map((part: any) => {
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
  sections.push(`# Pi/Cursor CLI bridge instructions

You are being used as the model backend for Pi Coding Agent through the local Cursor CLI.
The extension invokes Cursor strictly with \`cursor-agent -p --mode ask\` for each model turn.
Cursor runs in read-only "ask" mode: it must not edit files or run commands itself.
Pi, not Cursor, executes real file, shell, network, and MCP actions.

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

export function parseToolCalls(text: string): Array<{ name: string; arguments: Record<string, any> }> {
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
    "cursor-pi could not use the local Cursor CLI.",
    `Reason: ${error}`,
    INSTALL_GUIDANCE,
    "This provider never falls back to HTTP APIs or Pi built-in providers; every request must go through `cursor-agent -p`.",
  ].join(" ");
}

function runCapture(
  args: string[],
  input?: string,
  timeoutMs = STATUS_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cursorBin(), args, {
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${cursorBin()} timed out after ${timeoutMs}ms`));
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

/** Verify that the Cursor CLI binary exists and is runnable (`--version`). */
export async function checkCliInstalled(): Promise<CliStatus> {
  try {
    const result = await runCapture(["--version"]);
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `${cursorBin()} --version exited with code ${result.code}`;
      return { ok: false, summary: "Cursor CLI is unusable", detail };
    }
    const version = result.stdout.trim() || result.stderr.trim() || "cursor-agent is available";
    return { ok: true, summary: version };
  } catch (error) {
    return {
      ok: false,
      summary: "Cursor CLI is not installed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Verify Cursor authentication via `cursor-agent status`. */
export async function checkCliAuth(): Promise<CliStatus> {
  try {
    const result = await runCapture(["status"]);
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (/logged in/i.test(output)) {
      return { ok: true, summary: output.split("\n")[0]?.trim() || "Logged in" };
    }
    if (result.code !== 0) {
      return { ok: false, summary: "Not authenticated", detail: output || `status exited with code ${result.code}` };
    }
    return { ok: true, summary: output.split("\n")[0]?.trim() || "Authenticated" };
  } catch (error) {
    return {
      ok: false,
      summary: "Could not check Cursor auth",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export type CursorAboutInfo = {
  cliVersion?: string;
  model?: string;
  subscriptionTier?: string;
  userEmail?: string;
  osPlatform?: string;
  osArch?: string;
  terminalProgram?: string;
  shell?: string;
  lastRequestId?: string | null;
};

/** Parse `cursor-agent about` text output (key — value columns). */
export function parseAboutText(stdout: string): CursorAboutInfo {
  const info: CursorAboutInfo = {};
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(.+?)\s{2,}(.+)$/);
    if (!match) continue;
    const key = match[1]!.trim();
    const value = match[2]!.trim();
    switch (key) {
      case "CLI Version":
        info.cliVersion = value;
        break;
      case "Model":
        info.model = value;
        break;
      case "Subscription Tier":
        info.subscriptionTier = value;
        break;
      case "User Email":
        info.userEmail = value;
        break;
      case "OS": {
        const osMatch = value.match(/^(\S+)\s+\((\S+)\)$/);
        if (osMatch) {
          info.osPlatform = osMatch[1];
          info.osArch = osMatch[2];
        }
        break;
      }
      case "Terminal":
        info.terminalProgram = value;
        break;
      case "Shell":
        info.shell = value;
        break;
    }
  }
  return info;
}

/** Format plan/account lines for `/cursor-pi usage`. */
export function formatUsageLines(about: CursorAboutInfo): string[] {
  const lines = ["Cursor plan & account (from `cursor-agent about`):"];
  if (about.subscriptionTier) lines.push(`  Plan: ${about.subscriptionTier}`);
  if (about.userEmail) lines.push(`  Account: ${about.userEmail}`);
  if (about.model) lines.push(`  Default model: ${about.model}`);
  if (about.cliVersion) lines.push(`  CLI version: ${about.cliVersion}`);
  lines.push("");
  lines.push("Note: The Cursor CLI does not expose request quotas or billing usage.");
  lines.push("  Check https://cursor.com/settings or the Cursor app Usage tab for limits.");
  return lines;
}

async function fetchAboutInfo(): Promise<CursorAboutInfo | undefined> {
  try {
    const jsonResult = await runCapture(["about", "--format", "json"]);
    if (jsonResult.code === 0 && jsonResult.stdout.trim()) {
      return JSON.parse(jsonResult.stdout.trim()) as CursorAboutInfo;
    }
    const textResult = await runCapture(["about"]);
    if (textResult.code === 0) return parseAboutText(textResult.stdout);
  } catch {
    /* fall through */
  }
  return undefined;
}

async function listAvailableModels(): Promise<Array<{ id: string; name: string }> | undefined> {
  try {
    const result = await runCapture(["models"]);
    if (result.code !== 0) return undefined;
    const models = parseModelsList(result.stdout);
    return models.length > 0 ? models : undefined;
  } catch {
    return undefined;
  }
}

function streamCursorCli(
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
      const child = spawn(cursorBin(), buildCursorArgs(model.id), {
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
      if (timedOut) throw new Error(`cursor-agent -p timed out after ${timeout}ms`);
      if (code !== 0) throw new Error(stderr.trim() || `cursor-agent -p exited with code ${code}`);

      setEstimatedUsage(model, output, prompt, stdout);
      const responseText = stdout;

      const toolCalls = parseToolCalls(responseText);
      const proseText = responseText.replace(/<pi_tool_call>[\s\S]*?<\/pi_tool_call>/g, "").trim();
      if (toolCalls.length > 0) {
        output.stopReason = "toolUse";
        if (proseText) output.content.push({ type: "text", text: proseText });
        for (const call of toolCalls) {
          const toolCall: ToolCall = {
            type: "toolCall",
            id: `cursor_pi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
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
    name: `${model.name} (Cursor CLI)`,
    reasoning: model.reasoning,
    input: ["text"] as ("text" | "image")[],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
}

function registerCursorProvider(pi: ExtensionAPI) {
  pi.registerProvider(PROVIDER_ID, {
    name: "Cursor CLI",
    baseUrl: "cli:cursor-agent-p",
    apiKey: "cursor-cli-no-api-key",
    api: API_ID,
    models: providerModels(),
    streamSimple: streamCursorCli,
  });
}

function statusLines(status?: CliStatus, auth?: CliStatus): string[] {
  const lines = [
    `Provider: ${PROVIDER_ID}`,
    `Cursor binary: ${cursorBin()}`,
    "Transport: strictly local `cursor-agent -p --mode ask` per model turn",
    "Fallbacks: none (no HTTP API or built-in Pi provider)",
    'Own Cursor tools: read-only ask mode (no edits/shell by Cursor)',
    "Tool calling: prompt-bridged via <pi_tool_call> markers executed by Pi",
    `Registered models: ${registeredModels.length}`,
  ];

  const install = status ?? lastCliStatus;
  if (install) {
    lines.push(`CLI status: ${install.ok ? "ok" : "error"} — ${install.summary}`);
    if (install.detail) lines.push(`CLI detail: ${install.detail}`);
  } else {
    lines.push(`CLI status: run /${"cursor-pi"} status to verify \`${cursorBin()} --version\`.`);
  }

  if (auth) {
    lines.push(`Auth status: ${auth.ok ? "ok" : "warning"} — ${auth.summary}`);
    if (auth.detail) lines.push(`Auth detail: ${auth.detail}`);
  } else {
    lines.push(`Auth status: run /${"cursor-pi"} status to check \`cursor-agent status\`.`);
  }

  lines.push("");
  for (const model of registeredModels) lines.push(`  - ${PROVIDER_ID}/${model.id} — ${model.name}`);
  lines.push("");
  lines.push("Quick test:");
  lines.push(`  pi -p --provider ${PROVIDER_ID} --model ${registeredModels[0]?.id ?? "auto"} "Reply with exactly OK"`);
  lines.push("Direct Cursor CLI smoke test:");
  lines.push(`  echo "Reply with exactly OK" | ${cursorBin()} -p --mode ask`);
  return lines;
}

export default function cursorPiExtension(pi: ExtensionAPI) {
  registeredModels = configuredModels(process.env.CURSOR_PI_MODELS);
  registerCursorProvider(pi);

  pi.on("session_start", async (_event: any, ctx: any) => {
    lastCliStatus = await checkCliInstalled();
    if (!lastCliStatus.ok) {
      ctx.ui.notify(`cursor-pi: ${setupGuidance(lastCliStatus.detail ?? lastCliStatus.summary)}`, "warning");
      return;
    }

    const auth = await checkCliAuth();
    if (!auth.ok) {
      ctx.ui.notify(
        `cursor-pi: Cursor CLI found (${lastCliStatus.summary}) but you may not be logged in. Run \`${cursorBin()} login\`, then reload Pi.`,
        "warning",
      );
      return;
    }

    ctx.ui.notify(
      `cursor-pi: ready (${lastCliStatus.summary}, ${auth.summary}); registered ${registeredModels.length} Cursor CLI model(s). Use /model and pick ${PROVIDER_ID}.`,
      "info",
    );
  });

  pi.registerCommand("cursor-pi", {
    description: "Cursor CLI provider status, install/auth verification, and setup help",
    handler: async (args: string, ctx: any) => {
      const sub = args.trim().split(/\s+/).filter(Boolean)[0] ?? "status";

      if (sub === "status") {
        const install = await checkCliInstalled();
        lastCliStatus = install;
        const auth = install.ok ? await checkCliAuth() : undefined;
        const ok = install.ok && (!auth || auth.ok);
        for (const line of statusLines(install, auth)) ctx.ui.notify(line, ok ? "info" : "warning");
        if (!install.ok) ctx.ui.notify(INSTALL_GUIDANCE, "warning");
        return;
      }

      if (sub === "verify") {
        const install = await checkCliInstalled();
        if (!install.ok) {
          ctx.ui.notify(`✗ Cursor CLI not usable: ${install.summary}${install.detail ? ` (${install.detail})` : ""}`, "warning");
          ctx.ui.notify(INSTALL_GUIDANCE, "warning");
          return;
        }
        ctx.ui.notify(`✓ Cursor CLI installed: ${install.summary}`, "info");
        const auth = await checkCliAuth();
        if (auth.ok) {
          ctx.ui.notify(`✓ Authenticated: ${auth.summary}`, "info");
        } else {
          ctx.ui.notify(`⚠ Not authenticated: ${auth.detail ?? auth.summary}. Run \`${cursorBin()} login\`.`, "warning");
        }
        return;
      }

      if (sub === "usage") {
        const install = await checkCliInstalled();
        if (!install.ok) {
          ctx.ui.notify(`✗ Cursor CLI not usable: ${install.summary}${install.detail ? ` (${install.detail})` : ""}`, "warning");
          ctx.ui.notify(INSTALL_GUIDANCE, "warning");
          return;
        }
        const auth = await checkCliAuth();
        if (!auth.ok) {
          ctx.ui.notify(`⚠ Not authenticated: ${auth.detail ?? auth.summary}. Run \`${cursorBin()} login\`.`, "warning");
          return;
        }
        const about = await fetchAboutInfo();
        if (!about || (!about.subscriptionTier && !about.userEmail)) {
          ctx.ui.notify(`Could not read account info (\`${cursorBin()} about\`).`, "warning");
          return;
        }
        for (const line of formatUsageLines(about)) ctx.ui.notify(line, "info");
        return;
      }

      if (sub === "models") {
        ctx.ui.notify(`Registered models (override with CURSOR_PI_MODELS="id1,id2"):`, "info");
        for (const model of registeredModels) ctx.ui.notify(`  ${PROVIDER_ID}/${model.id} — ${model.name}`, "info");
        const available = await listAvailableModels();
        if (available) {
          ctx.ui.notify(`Available on your account (\`${cursorBin()} models\`): ${available.length}`, "info");
          for (const model of available.slice(0, 40)) ctx.ui.notify(`  ${model.id} — ${model.name}`, "info");
        } else {
          ctx.ui.notify(`Could not list account models (\`${cursorBin()} models\`). Check auth with /cursor-pi verify.`, "warning");
        }
        return;
      }

      if (sub === "test") {
        ctx.ui.notify(
          `Run: pi -p --provider ${PROVIDER_ID} --model ${registeredModels[0]?.id ?? "auto"} "Reply with exactly OK"`,
          "info",
        );
        ctx.ui.notify(
          `Strict transport check: echo "Reply with exactly OK" | ${cursorBin()} -p --output-format text --mode ask`,
          "info",
        );
        return;
      }

      if (sub === "help") {
        ctx.ui.notify("Usage: /cursor-pi [status|verify|usage|models|test|help]", "info");
        ctx.ui.notify("Set CURSOR_PI_BIN to override the cursor-agent executable.", "info");
        ctx.ui.notify('Set CURSOR_PI_MODELS="auto,composer-2.5" for comma-separated Cursor model ids.', "info");
        ctx.ui.notify("Set CURSOR_PI_TIMEOUT_MS for per-turn timeout and CURSOR_PI_CONTEXT_WINDOW to override advertised context.", "info");
        ctx.ui.notify("Every provider call spawns local `cursor-agent -p --mode ask`; there is no API fallback.", "info");
        return;
      }

      ctx.ui.notify(`Unknown /cursor-pi subcommand: ${sub}. Try /cursor-pi help`, "warning");
    },
  });
}
