import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  calculateCost,
  createAssistantMessageEventStream,
  registerApiProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  API_ID,
  BUNDLED_MODELS,
  cleanHermesOutput,
  configuredModels,
  discoverCachedFreeModels,
  estimateTokens,
  hermesBin,
  hermesProvider,
  PROVIDER_ID,
  resolveModelInfos,
  type HermesModelInfo,
} from "./lib.js";

const STDERR_LIMIT = 20_000;

let registeredModels: HermesModelInfo[] = [];
let lastDiscoveryTime: number | undefined;
let lastDiscoveryError: string | undefined;

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
    const models = resolveModelInfos(configured);
    registeredModels = models;
    lastDiscoveryTime = now;
    return { models, time: now, error: undefined };
  }

  if (!opts?.forceDiscovery && registeredModels.length > 0) {
    return {
      models: registeredModels,
      time: lastDiscoveryTime ?? now,
      error: undefined,
    };
  }

  // Discovery: free models from the hermes CLI provider cache
  try {
    const home = process.env.HOME || "";
    let discoveredIds: string[] = [];

    const cachePath = join(home, ".hermes", "provider_models_cache.json");
    if (home && existsSync(cachePath)) {
      discoveredIds = await discoverCachedFreeModels(home, (p) =>
        readFile(p, "utf8"),
      );
    }

    registeredModels = discoveredIds.length
      ? resolveModelInfos(discoveredIds)
      : [...BUNDLED_MODELS];
    lastDiscoveryTime = now;
    lastDiscoveryError = undefined;
    return { models: registeredModels, time: now, error: undefined };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    lastDiscoveryError = msg;
    registeredModels = [...BUNDLED_MODELS];
    lastDiscoveryTime = now;
    return { models: registeredModels, time: now, error: msg };
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

/** Build the prompt text from Pi messages for hermes chat */
function buildPrompt(context: Context): string {
  return context.messages
    .map((msg) => {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .map((c) => (c.type === "text" ? c.text : ""))
              .join("\n");
      if (msg.role === "user") return `USER:\n${text}`;
      if (msg.role === "assistant") return `ASSISTANT:\n${text}`;
      if (msg.role === "toolResult") return `TOOL_RESULT:\n${text}`;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/** Stream hermes output via `hermes chat -q "prompt" -m <model> --provider nous --cli` */
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

    let stdout = "";

    try {
      stream.push({ type: "start", partial: output });
      if (options?.signal?.aborted) throw new Error("Request was aborted");

      const prompt = buildPrompt(context);
      const args = [
        "chat",
        "-q",
        prompt,
        "-m",
        model.id,
        "--provider",
        hermesProvider(),
        "--cli",
      ];

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
      });

      await new Promise<void>((resolve) => {
        child.on("close", () => resolve());
        child.on("error", () => resolve());
      });

      const content = cleanHermesOutput(stdout);
      const contentIndex = output.content.length;
      output.content = [{ type: "text", text: content || "No response from Hermes." }];
      output.stopReason = "stop";

      stream.push({ type: "text_start", contentIndex, partial: output });
      stream.push({ type: "text_delta", contentIndex, delta: content || "No response from Hermes.", partial: output });
      stream.push({ type: "text_end", contentIndex, content: content || "No response from Hermes.", partial: output });

      const lastUserMsg = context.messages[context.messages.length - 1];
      const promptText = lastUserMsg
        ? typeof lastUserMsg.content === "string"
          ? lastUserMsg.content
          : lastUserMsg.content.map((c) => (c.type === "text" ? c.text : "")).join("\n")
        : "";
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
    `hermes provider: ${hermesProvider()}`,
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
  lines.push('Set HERMES_PI_MODELS="tencent/hy3:free,stepfun/step-3.7-flash:free" to use specific models.');
  lines.push(`Set HERMES_PI_PROVIDER to override the hermes CLI provider (default: ${hermesProvider()}).`);
  lines.push("Run /hermes-pi update then /reload to refresh the model list.");
  return lines;
}

export default function hermesPiExtension(pi: ExtensionAPI) {
  // Register synchronously from bundled/env-configured models so the
  // provider exists before any session starts. Async CLI discovery here
  // resolves after session replacement and makes the extension ctx stale
  // (registerProvider throws "ctx is stale"), so the provider never loads.
  // Use /hermes-pi update (+ /reload) to pick up freshly discovered models.
  const modelIds = configuredModels() ?? BUNDLED_MODELS.map((m) => m.id);
  registeredModels = resolveModelInfos(modelIds);

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
  });

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
          'Override with HERMES_PI_MODELS="tencent/hy3:free,stepfun/step-3.7-flash:free"',
          "info",
        );
        return;
      }
      if (sub === "test") {
        const testModel = registeredModels[0]?.id ?? BUNDLED_MODELS[0]?.id ?? "tencent/hy3:free";
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
        if (error) ctx.ui.notify(`hermes-pi: discovery issue: ${error}`, "warning");
        ctx.ui.notify(
          "Run /reload to apply the refreshed model list to the provider.",
          "info",
        );
        return;
      }
      if (sub === "help") {
        ctx.ui.notify("Usage: /hermes-pi [status|models|test|update|help]", "info");
        ctx.ui.notify("Set HERMES_PI_BIN to override the hermes executable.", "info");
        ctx.ui.notify("Set HERMES_PI_PROVIDER to override the hermes CLI provider.", "info");
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
