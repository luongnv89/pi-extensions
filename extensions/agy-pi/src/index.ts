import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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

const BUNDLED_MODELS: AgyModelInfo[] = [
  bundledModel("gemini-3.7-flash-high", "Gemini 3.7 Flash"),
  bundledModel("gemini-3.7-flash-medium", "Gemini 3.7 Flash"),
  bundledModel("gemini-3.7-flash-low", "Gemini 3.7 Flash"),
  bundledModel("gemini-3.6-flash-high", "Gemini 3.6 Flash"),
  bundledModel("gemini-3.6-flash-medium", "Gemini 3.6 Flash"),
  bundledModel("gemini-3.6-flash-low", "Gemini 3.6 Flash"),
  bundledModel("gemini-3.5-flash-high", "Gemini 3.5 Flash"),
  bundledModel("gemini-3.5-flash-medium", "Gemini 3.5 Flash"),
  bundledModel("gemini-3.5-flash-low", "Gemini 3.5 Flash"),
  bundledModel("gemini-3.1-pro-high", "Gemini 3.1 Pro"),
  bundledModel("gemini-3.1-pro-low", "Gemini 3.1 Pro"),
  bundledModel("claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)", 200_000),
  bundledModel("claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)", 200_000),
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

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function effortOf(id: string): string | undefined {
  return id.match(/-(high|medium|low)$/)?.[1];
}

/** Collapse -high/-medium/-low variant ids into one base model per family. */
function toBaseModels(ids: string[]): AgyModelInfo[] {
  const groups = new Map<string, { levels: Set<string>; bundled?: AgyModelInfo }>();
  for (const id of dedupe(ids)) {
    const effort = effortOf(id);
    const baseId = effort ? id.slice(0, id.length - effort.length - 1) : id;
    let group = groups.get(baseId);
    if (!group) {
      group = { levels: new Set() };
      const bundled = BUNDLED_MODELS.find((m) => m.id === baseId);
      if (bundled) group.bundled = { ...bundled };
      groups.set(baseId, group);
    }
    if (effort) group.levels.add(effort);
  }
  return [...groups.entries()].map(([baseId, group]) => ({
    id: baseId,
    name: group.bundled?.name ?? modelDisplayName(baseId),
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

    const modelIds = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    registeredModels = toBaseModels(configured?.length ? configured : modelIds);

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

    try {
      stream.push({ type: "start", partial: output });
      if (options?.signal?.aborted) throw new Error("Request was aborted");

      const prompt = buildPrompt(context);
      // agy quirk (upstream issues #83/#581): --model must come BEFORE -p,
      // otherwise print mode silently ignores it and runs the default model.
      // When --model is set, the prompt must be passed as the -p value;
      // stdin is only read on the legacy `--print` path.
      // Oversized prompts can exceed OS argv limits, so those fall back to
      // the legacy stdin invocation (model pinning is lost in that case).
      const useArgvPrompt = Buffer.byteLength(prompt) <= MAX_ARGV_PROMPT_BYTES;
      const slug = agySlugForLevel(model.id, options?.reasoning);
      const args = useArgvPrompt
        ? ["--model", slug, "-p", prompt]
        : ["--print"];

      const child = spawn(agyBin(), args, {
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

      child.stdin!.end(useArgvPrompt ? undefined : prompt);
      child.stdout!.setEncoding("utf8");
      child.stderr!.setEncoding("utf8");

      child.stdout!.on("data", (chunk) => {
        stdout += chunk;
        const text = stdout.trim();
        if (text) {
          const contentIndex = output.content.length;
          output.content = [{ type: "text", text }];
          stream.push({ type: "text_start", contentIndex, partial: output });
          stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
          stream.push({ type: "text_end", contentIndex, content: text, partial: output });
        }
      });

      child.stderr!.on("data", (chunk) => {
        stderr += chunk;
      });

      let spawnError: Error | undefined;
      await new Promise<void>((resolve) => {
        child.on("close", () => resolve());
        child.on("error", (error) => {
          spawnError = error;
          resolve();
        });
      });

      if (spawnError) {
        throw new Error(
          setupGuidance(`failed to launch ${agyBin()}: ${spawnError.message}`),
        );
      }

      // Clean output
      const content = stdout.trim();
      const contentIndex = output.content.length;
      output.content = [{ type: "text", text: content || "No response from agy." }];
      output.stopReason = "stop";

      stream.push({ type: "text_start", contentIndex, partial: output });
      stream.push({ type: "text_delta", contentIndex, delta: content || "No response from agy.", partial: output });
      stream.push({ type: "text_end", contentIndex, content: content || "No response from agy.", partial: output });

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
  lines.push("Set AGY_PI_MODELS=\"gemini-3.6-flash-high,gpt-oss-120b-medium\" to use specific models.");
  lines.push("Run /agy-pi update to refresh the model list.");
  return lines;
}

export default function agyPiExtension(pi: ExtensionAPI) {
  // Register synchronously from bundled/env-configured models so the
  // provider exists before any session starts. Async CLI discovery here
  // resolves after session replacement and makes the extension ctx stale
  // (registerProvider throws "ctx is stale"), so the provider never loads.
  // Use /agy-pi update (+ /reload) to pick up freshly discovered models.
  const modelIds = configuredModels() ?? BUNDLED_MODELS.map((m) => m.id);
  registeredModels = toBaseModels(modelIds);

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

  pi.on("session_start", async (_event: any, ctx: any) => {
    const cliStatus = await checkAgyStatus();
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
      const sub = args.trim().split(/\s+/).filter(Boolean)[0] ?? "status";
      if (sub === "status") {
        for (const line of statusLines()) ctx.ui.notify(line, "info");
        return;
      }
      if (sub === "models") {
        for (const model of registeredModels)
          ctx.ui.notify(`${PROVIDER_ID}/${model.id}`, "info");
        ctx.ui.notify(
          `Override with AGY_PI_MODELS="gemini-3.6-flash-high,claude-sonnet-4-6"`,
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
