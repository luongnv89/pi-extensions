import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

const PROVIDER_ID = "hermes";
const API_ID = "hermes-runner";
const AGENT_ID = "pi-model";
const DEFAULT_CONTEXT_WINDOW = 131_072;
const DEFAULT_MAX_TOKENS = 8_192;
const STDERR_LIMIT = 20_000;

// Default Hermes models — users can override with HERMES_PI_MODELS
const BUNDLED_MODELS: HermesModelInfo[] = [
  {
    id: "nousresearch/hermes3-llama-3.4-12b",
    name: "Hermes 3 Llama 3.4 12B",
    contextWindow: 131_072,
    maxTokens: 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "nousresearch/hermes3-llama-3.2-8b",
    name: "Hermes 3 Llama 3.2 8B",
    contextWindow: 131_072,
    maxTokens: 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "meta-llama/llama-3.3-70b-instruct",
    name: "Llama 3.3 70B Instruct",
    contextWindow: 131_072,
    maxTokens: 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "qwen/qwen2.5-coder-32b-instruct",
    name: "Qwen 2.5 Coder 32B Instruct",
    contextWindow: 32_768,
    maxTokens: 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "microsoft/phi-4",
    name: "Phi-4",
    contextWindow: 16_384,
    maxTokens: 4_096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "mistralai/mistral-large-2-instruct",
    name: "Mistral Large 2 Instruct",
    contextWindow: 131_072,
    maxTokens: 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
];

export interface HermesModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  reasoning?: boolean;
  image?: boolean;
}

let registeredModels: HermesModelInfo[] = [];
let lastDiscoveryTime: number | undefined;
let lastDiscoveryError: string | undefined;

function hermesBin(): string {
  return process.env.HERMES_PI_BIN?.trim() || "hermes";
}

function configuredModels(): string[] | undefined {
  const raw = process.env.HERMES_PI_MODELS?.trim();
  if (!raw) return undefined;
  return raw
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function modelDisplayName(model: string): string {
  return `Hermes ${model}`;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function fallbackModel(id: string): HermesModelInfo {
  return {
    id,
    name: modelDisplayName(id),
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

async function runCapture(
  args: string[],
  timeoutMs = 60_000,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(hermesBin(), args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`hermes timed out after ${timeoutMs}ms`));
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

export async function discoverModels(opts?: {
  forceDiscovery?: boolean;
}): Promise<{
  models: HermesModelInfo[];
  time: number;
  error: string | undefined;
}> {
  const now = Date.now();
  const configured = configuredModels();

  // Fast path: explicit model list
  if (configured?.length) {
    lastDiscoveryError = undefined;
    const models = configured.map((id) => {
      const existing = BUNDLED_MODELS.find((m) => m.id === id);
      return existing ? { ...existing } : fallbackModel(id);
    });
    registeredModels = models;
    lastDiscoveryTime = now;
    return { models, time: now, error: undefined };
  }

  // Discovery: try to detect available models from hermes config
  try {
    const configPath = join(process.env.HOME || "", ".hermes", "config.yaml");
    let discoveredIds: string[] = [];

    if (existsSync(configPath)) {
      const configContent = await readFile(configPath, "utf8");
      const modelMatches = configContent.match(/model:\s*[^\s#]+/g);
      if (modelMatches) {
        discoveredIds = modelMatches.map((m) => m.replace("model:", "").trim());
      }
    }

    if (discoveredIds.length > 0) {
      registeredModels = discoveredIds.map((id) => {
        const existing = BUNDLED_MODELS.find((m) => m.id === id);
        return existing ? { ...existing } : fallbackModel(id);
      });
    } else {
      registeredModels = [...BUNDLED_MODELS];
    }

    lastDiscoveryTime = now;
    lastDiscoveryError = undefined;
    return { models: registeredModels, time: now, error: undefined };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    lastDiscoveryError = msg;
    registeredModels = [...BUNDLED_MODELS];
    lastDiscoveryTime = now;
    return { models: registeredModels, time: now, error: undefined };
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

/** Build the prompt text from Pi messages for hermes chat */
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

/** Extract clean text from hermes output (removes box-drawing UI elements) */
function cleanHermesOutput(raw: string): string {
  let content = raw.trim();

  // Remove ANSI escape codes
  content = content.replace(/\x1b\[[0-9;]*m/g, "");

  // Remove box-drawing UI (╭─ ... ─╮ format)
  const boxMatch = content.match(/╭[─]+\s*\n([\s\S]*?)\n╰[─]+/);
  if (boxMatch) {
    content = boxMatch[1].trim();
  }

  // Remove reasoning blocks (┌─ Reasoning ─ ... ─┘)
  const reasonMatch = content.match(/┌[─]+ Reasoning [─]+\n([\s\S]*?)\n└[─]+/);
  if (reasonMatch) {
    content = content.replace(reasonMatch[0], "").trim();
  }

  // Remove session resume hints
  content = content.replace(/Resume this session with:\s*\n\s*hermes\s*[^\n]+/g, "");
  content = content.replace(/Session:\s*[^\n]+\s*Duration:\s*[^\n]+\s*Messages:\s*[^\n]+/g, "");
  content = content.replace(/Query:\s*[^\n]+\s*\n?/g, "");
  content = content.replace(/Initializing agent\.\.\.\s*\n?[\─│]+/g, "");

  // Remove any remaining box decorations
  content = content.replace(/[│┌┐└┘─╭╮╰╯]/g, "");

  return content.trim();
}

/** Stream hermes output via `hermes chat -q "prompt" -m <model> --cli` */
function streamHermes(
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

    try {
      stream.push({ type: "start", partial: output });
      if (options?.signal?.aborted) throw new Error("Request was aborted");

      const prompt = buildPrompt(context);
      const args = ["chat", "-q", prompt, "-m", model.id, "--cli"];

      const child = spawn(hermesBin(), args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      const abort = () => child.kill("SIGTERM");
      options?.signal?.addEventListener("abort", abort, { once: true });

      if (
        typeof options?.timeoutMs === "number" &&
        Number.isFinite(options.timeoutMs) &&
        options.timeoutMs > 0
      ) {
        setTimeout(() => {
          child.kill("SIGTERM");
        }, options.timeoutMs);
      }

      child.stdout!.setEncoding("utf8");
      child.stderr!.setEncoding("utf8");

      child.stdout!.on("data", (chunk) => {
        stdout += chunk;
        const cleaned = cleanHermesOutput(stdout);
        if (cleaned) {
          const contentIndex = output.content.length;
          output.content = [{ type: "text", text: cleaned }];
          stream.push({ type: "text_start", contentIndex, partial: output });
          stream.push({ type: "text_delta", contentIndex, delta: cleaned, partial: output });
          stream.push({ type: "text_end", contentIndex, content: cleaned, partial: output });
        }
      });

      child.stderr!.on("data", (chunk) => {
        stderr += chunk;
      });

      await new Promise<void>((resolve) => {
        child.on("close", () => resolve());
        child.on("error", () => resolve());
      });

      // Clean output
      const content = cleanHermesOutput(stdout);
      const contentIndex = output.content.length;
      output.content = [{ type: "text", text: content || "No response from Hermes." }];
      output.stopReason = "stop";

      stream.push({ type: "text_start", contentIndex, partial: output });
      stream.push({ type: "text_delta", contentIndex, delta: content || "No response from Hermes.", partial: output });
      stream.push({ type: "text_end", contentIndex, content: content || "No response from Hermes.", partial: output });

      const lastUserMsg = context.messages[context.messages.length - 1];
      const promptText = lastUserMsg ? (typeof lastUserMsg.content === "string" ? lastUserMsg.content : lastUserMsg.content.map(c => c.type === "text" ? c.text : "").join("\n")) : "";
      setEstimatedUsage(model, output, promptText, content);

      stream.push({ type: "done", reason: "stop", message: output });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      output.content = [{ type: "text", text: `Error: ${errMsg}` }];
      output.stopReason = "error";
      stream.push({ type: "error", reason: "error", error: output });
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

function providerModel(model: HermesModelInfo) {
  const inputTypes: Array<"text" | "image"> = model.image ? ["text", "image"] : ["text"];
  return {
    id: model.id,
    name: `${model.name} (Hermes)`,
    reasoning: model.reasoning ?? false,
    input: inputTypes,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: model.cost,
  };
}

function statusLines(): string[] {
  const lines = [
    `Provider: ${PROVIDER_ID}`,
    `hermes binary: ${hermesBin()}`,
    `hermes installed: ${existsSync(hermesBin()) || hermesBin() === "hermes" ? "yes (via PATH)" : "no"}`,
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
  lines.push("Requires: hermes installed + `hermes login` (Nous Portal, free)");
  lines.push("Set HERMES_PI_MODELS=\"nousresearch/hermes3-llama-3.4-12b,meta-llama/llama-3.3-70b-instruct\" to use specific models.");
  lines.push("Run /hermes-pi update to refresh the model list.");
  return lines;
}

export default function hermesPiExtension(pi: ExtensionAPI) {
  async function setupProvider() {
    const { models, time, error } = await discoverModels();
    registeredModels = models;
    lastDiscoveryTime = time;

    pi.registerProvider(PROVIDER_ID, {
      name: "Hermes Agent",
      baseUrl: "cli:hermes",
      apiKey: "hermes-cli-no-api-key",
      api: API_ID,
      models: registeredModels.map(providerModel),
      streamSimple: streamHermes,
    });

    registerApiProvider(
      {
        api: API_ID,
        stream: (model, context, options) => streamHermes(model, context, options),
        streamSimple: streamHermes,
      },
      PROVIDER_ID,
    );

    pi.on("session_start", async (_event: any, ctx: any) => {
      ctx.ui.notify(
        `hermes-pi: registered ${registeredModels.length} model(s). Use /model and pick ${PROVIDER_ID}.`,
        "info",
      );
      if (error) {
        ctx.ui.notify(`hermes-pi: discovery issue: ${error}`, "warning");
      }
    });
  }

  setupProvider();

  pi.registerCommand("hermes-pi", {
    description: "Hermes Agent CLI bridge status and setup help",
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
          `Override with HERMES_PI_MODELS="nousresearch/hermes3-llama-3.4-12b,meta-llama/llama-3.3-70b-instruct"`,
          "info",
        );
        return;
      }
      if (sub === "test") {
        const testModel = registeredModels[0]?.id ?? BUNDLED_MODELS[0]?.id ?? "nousresearch/hermes3-llama-3.4-12b";
        ctx.ui.notify(
          `Run: pi -p --provider ${PROVIDER_ID} --model ${testModel} "Reply with exactly OK"`,
          "info",
        );
        return;
      }
      if (sub === "update") {
        await setupProvider();
        for (const line of statusLines()) ctx.ui.notify(line, "info");
        return;
      }
      if (sub === "help") {
        ctx.ui.notify("Usage: /hermes-pi [status|models|test|update|help]", "info");
        ctx.ui.notify("Set HERMES_PI_BIN to override the hermes executable.", "info");
        ctx.ui.notify("Set HERMES_PI_MODELS to register a custom comma-separated model list.", "info");
        return;
      }
      ctx.ui.notify(
        `Unknown /hermes-pi subcommand: ${sub}. Try /hermes-pi help`,
        "warning",
      );
    },
  });
}
