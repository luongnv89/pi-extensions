import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  calculateCost,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  normalizeContext,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type SystemMessage,
  type ModelThinkingLevel,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingLevelMap,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import {
  runningOpenCodeServer,
  serverRequest,
  subscribeEvents,
  withOpenCodeServer,
  type ServerEvent,
} from "./server.js";

type TranscriptMessage = Exclude<Message, SystemMessage>;

interface BridgeContext {
  systemPrompt: string;
  tools: Tool[];
  messages: TranscriptMessage[];
}

const PROVIDER_ID = "opencode-cli";
const API_ID = "opencode-cli-runner";
const AGENT_ID = "pi-model";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const DISCOVERY_TIMEOUT_MS = 8_000;
const STATUS_TIMEOUT_MS = 10_000;
const SESSION_DELETE_TIMEOUT_MS = 10_000;
const STDERR_LIMIT = 20_000;
/**
 * Upper bound for every model turn, applied even when Pi supplies no
 * `timeoutMs`. A session ID reused from the wrong project directory hangs
 * with empty stdout/stderr, so no turn may wait indefinitely (#73).
 */
const DEFAULT_TURN_TIMEOUT_MS = 180_000;
/** Cap on tracked Pi sessions; the oldest entry is evicted with cleanup. */
const MAX_TRACKED_PI_SESSIONS = 10;

export type CliStatus = {
  ok: boolean;
  summary: string;
  detail?: string;
};

const DEFAULT_FREE_MODELS = [
  "opencode/big-pickle",
  "opencode/ling-3.0-flash-fin-free",
  "opencode/mimo-v2.6-flash-free",
  "opencode/muse-spark-1.3-contributor-free",
  "opencode/nemotron-3-ultra-free",
  "opencode/nemotron-3.5-lightning-free",
  "opencode/space-bunny-free",
];
export type ModelCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};
const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
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
  cost: ModelCost;
  /** True when `cost` was read from discovery metadata rather than defaulted. */
  costFromMetadata?: boolean;
  status?: string;
  thinkingLevelMap?: ThinkingLevelMap;
};

let registeredModels: OpenCodeModelInfo[] = [];
let lastDiscoveryTime: number | undefined;
let lastDiscoveryError: string | undefined;
let lastDiscoverySkipped: boolean | undefined;
let lastCliAvailable: boolean | undefined;

const OPENCODE_PANEL_STATUS = "Status (cached)";
const OPENCODE_PANEL_CONFIG = "Configuration (environment presence)";
const OPENCODE_PANEL_MODELS = "Models (cached)";
const OPENCODE_PANEL_BACK = "Back";
const OPENCODE_PANEL_CLOSE = "Close";

function panelEnvState(name: string): string {
  return process.env[name]?.trim() ? "set" : "default";
}

function cachedPanelState(value: boolean | undefined, positive: string, negative: string): string {
  if (value === undefined) return "not checked";
  return value ? positive : negative;
}

export async function showOpenCodePanelList(ctx: any, title: string, lines: string[]): Promise<"back" | "close"> {
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
      OPENCODE_PANEL_BACK,
      OPENCODE_PANEL_CLOSE,
    ];
    const counter = ` (${page + 1}/${records.length})`;
    let heading = title;
    if (heading.length + counter.length > 38) heading = heading.replace(/\s+\([^()]*\)$/u, "");
    if (heading.length + counter.length > 38) heading = heading.slice(0, Math.min(30, 38 - counter.length));
    const choice = await ctx.ui.select(`${heading}${counter}`, options);
    if (choice === undefined || choice === OPENCODE_PANEL_CLOSE) return "close";
    if (choice === OPENCODE_PANEL_BACK) return "back";
    if (choice === "Previous" && page > 0) page -= 1;
    if (choice === "Next" && page < records.length - 1) page += 1;
  }
}

async function showOpenCodePanel(ctx: any): Promise<void> {
  while (true) {
    const choice = await ctx.ui.select("opencode-pi (read-only)", [
      OPENCODE_PANEL_STATUS,
      OPENCODE_PANEL_CONFIG,
      OPENCODE_PANEL_MODELS,
      OPENCODE_PANEL_CLOSE,
    ]);
    if (choice === undefined || choice === OPENCODE_PANEL_CLOSE) return;

    if (choice === OPENCODE_PANEL_STATUS) {
      const discovery = lastDiscoveryTime
        ? lastDiscoverySkipped
          ? "configured/skipped"
          : lastDiscoveryError === undefined
            ? "complete"
            : "fallback"
        : "not checked";
      const detail = await showOpenCodePanelList(ctx, "OpenCode CLI status (cached)", [
        `CLI: ${cachedPanelState(lastCliAvailable, "available", "unavailable")}`,
        `Model discovery: ${discovery}`,
        `Registered models: ${registeredModels.length}`,
      ]);
      if (detail === "close") return;
      continue;
    }

    if (choice === OPENCODE_PANEL_CONFIG) {
      const detail = await showOpenCodePanelList(ctx, "opencode-pi configuration (environment presence)", [
        `OPENCODE_PI_BIN: ${panelEnvState("OPENCODE_PI_BIN")}`,
        `OPENCODE_PI_MODELS: ${panelEnvState("OPENCODE_PI_MODELS")}`,
      ]);
      if (detail === "close") return;
      continue;
    }

    if (choice === OPENCODE_PANEL_MODELS) {
      const detail = await showOpenCodePanelList(ctx, "OpenCode models (cached)", [
        `Registered models: ${registeredModels.length}`,
        "IDs hidden to avoid exposing configured values",
      ]);
      if (detail === "close") return;
      continue;
    }

    return;
  }
}

type CliDialect = "v1" | "v2";
let detectedCli: { bin: string; dialect: CliDialect } | undefined;

async function cliDialect(forceVersion = false): Promise<CliDialect> {
  const bin = opencodeBin();
  if (!forceVersion && detectedCli?.bin === bin) return detectedCli.dialect;
  const result = await runCapture(["--version"], undefined, STATUS_TIMEOUT_MS);
  const dialect = result.code === 0 ? dialectOf(result.stdout.trim() || result.stderr.trim()) : undefined;
  if (!dialect) {
    throw new Error("Cannot determine OpenCode CLI version for run arguments");
  }
  detectedCli = { bin, dialect };
  return dialect;
}

function dialectOf(version: string): CliDialect | undefined {
  const major = Number(version.match(/^(?:opencode\s+)?v?(\d+)\.\d+\.\d+(?:[-+][\w.-]+)?$/i)?.[1]);
  if (!(major >= 1)) return undefined;
  return major >= 2 ? "v2" : "v1";
}

/** CLI failures can print a whole help screen; keep one short line. */
function conciseError(text: string): string {
  const line = text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

// Discovered models are cached so startup can register them without
// waiting on the CLI.
function modelCachePath(): string {
  return join(getAgentDir(), "cache", "opencode-pi-models.json");
}

async function readModelCache(): Promise<OpenCodeModelInfo[] | undefined> {
  try {
    const cache = JSON.parse(await readFile(modelCachePath(), "utf8"));
    return cache?.bin === opencodeBin() && Array.isArray(cache.models) && cache.models.length > 0
      ? cache.models
      : undefined;
  } catch {
    return undefined;
  }
}

async function writeModelCache(models: OpenCodeModelInfo[]): Promise<void> {
  const path = modelCachePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ bin: opencodeBin(), models }), "utf8");
}

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

/** Read a non-negative finite cost figure; anything else means "unknown". */
function costFigure(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** v1 reports `cost` as an object, v2 as an array of cost entries. */
function costEntry(cost: unknown): {
  input?: unknown;
  output?: unknown;
  cache?: { read?: unknown; write?: unknown };
} {
  const value = Array.isArray(cost) ? cost[0] : cost;
  return typeof value === "object" && value !== null
    ? (value as {
        input?: unknown;
        output?: unknown;
        cache?: { read?: unknown; write?: unknown };
      })
    : {};
}

/**
 * Read the real per-model cost from discovery metadata (#78).
 * Missing or malformed figures fall back to zero so a model is never
 * reported with an invented non-zero cost.
 */
export function parseModelCost(metadata: unknown): ModelCost {
  const cost = costEntry((metadata as { cost?: unknown } | null)?.cost);
  return {
    input: costFigure(cost.input) ?? 0,
    output: costFigure(cost.output) ?? 0,
    cacheRead: costFigure(cost.cache?.read) ?? 0,
    cacheWrite: costFigure(cost.cache?.write) ?? 0,
  };
}

/**
 * Free models are identified by zero input and output cost in the discovery
 * metadata (#77). When a record carries no usable cost figures (older CLI
 * output), fall back to the legacy `-free` name pattern so paid models are
 * never misregistered as free.
 */
export function isFreeModel(model: {
  id: string;
  cost: ModelCost;
  costFromMetadata?: boolean;
}): boolean {
  if (model.cost.input !== 0 || model.cost.output !== 0) return false;
  if (model.costFromMetadata === true) return true;
  return looksFree(model.id);
}

/**
 * Discovery metadata carries a per-model status field (#79). Only `active`
 * models are registered; a missing status is treated as active so older CLI
 * output without the field keeps working.
 */
export function isActiveModel(status: unknown): boolean {
  if (status === undefined || status === null) return true;
  return String(status).trim().toLowerCase() === "active";
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

/** v1 reports `capabilities.input` as `{ image }`, v2 as a modality array. */
function supportsImage(input: unknown): boolean {
  if (Array.isArray(input)) return input.includes("image");
  return (input as { image?: unknown } | null | undefined)?.image === true;
}

/** v2 dropped `capabilities.reasoning`; reasoning shows up as effort variants. */
function hasReasoningVariant(variants: unknown): boolean {
  if (!Array.isArray(variants)) return false;
  return variants.some((variant) => {
    const settings = (variant as { settings?: Record<string, unknown> } | null)
      ?.settings;
    return (
      settings?.reasoningEffort !== undefined || settings?.reasoning !== undefined
    );
  });
}

function variantNames(variants: unknown): Set<string> {
  if (Array.isArray(variants)) {
    return new Set(
      variants.flatMap((variant) => {
        const id = (variant as { id?: unknown } | null)?.id;
        return typeof id === "string" ? [id] : [];
      }),
    );
  }
  return typeof variants === "object" && variants !== null
    ? new Set(Object.keys(variants))
    : new Set<string>();
}

function thinkingLevelMap(variants: unknown): ThinkingLevelMap {
  const map: ThinkingLevelMap = {};
  const names = variantNames(variants);

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

type DiscoveryMetadata = {
  name?: unknown;
  status?: unknown;
  cost?: unknown;
  limit?: { context?: unknown; output?: unknown };
  capabilities?: { reasoning?: unknown; input?: unknown };
  variants?: unknown;
};

/** Map one discovery record to registered model metadata (v1 and v2 shapes). */
function modelInfoFromMetadata(
  id: string,
  value: DiscoveryMetadata,
): OpenCodeModelInfo {
  const cost = parseModelCost(value);
  const entry = costEntry(value.cost);
  const costFromMetadata =
    costFigure(entry.input) !== undefined && costFigure(entry.output) !== undefined;
  const reasoning =
    value.capabilities?.reasoning === true || hasReasoningVariant(value.variants);
  const status =
    typeof value.status === "string" && value.status.trim()
      ? value.status.trim()
      : undefined;
  return {
    id,
    name:
      typeof value.name === "string" && value.name.trim()
        ? value.name.trim()
        : modelDisplayName(id),
    reasoning,
    image: supportsImage(value.capabilities?.input),
    contextWindow: positiveNumber(value.limit?.context, contextWindowFor(id)),
    maxTokens: positiveNumber(value.limit?.output, maxTokensFor(id)),
    cost,
    ...(costFromMetadata ? { costFromMetadata: true as const } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(reasoning ? { thinkingLevelMap: thinkingLevelMap(value.variants) } : {}),
  };
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

    records.set(id, modelInfoFromMetadata(id, metadata as DiscoveryMetadata));
  }
  return [...records.values()];
}

/**
 * Parse the `opencode api GET /api/model` payload from OpenCode v2, which
 * replaced `opencode models <provider> --verbose` with an HTTP API.
 * ponytail: only the `opencode` provider is read; extend when the
 * extension learns to serve other providers.
 */
export function parseApiModels(output: string): OpenCodeModelInfo[] {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    return [];
  }
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];

  const records: OpenCodeModelInfo[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const value = entry as DiscoveryMetadata & {
      providerID?: unknown;
      modelID?: unknown;
    };
    if (value.providerID !== "opencode" || typeof value.modelID !== "string") {
      continue;
    }
    const model = value.modelID;
    const id = model.startsWith("opencode/")
      ? model
      : `opencode/${model}`;
    records.push(modelInfoFromMetadata(id, value));
  }
  return records;
}

/** Parse the plain `provider/model` ID list printed by `opencode models`. */
export function parseModelList(output: string): string[] {
  return dedupe(
    output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^opencode\/[^\s]+$/.test(line)),
  );
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

/** Run a capture command and return stdout, throwing on a non-zero exit. */
async function captureOk(args: string[]): Promise<string> {
  const result = await runCapture(args);
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `opencode ${args.join(" ")} exited with code ${result.code}`,
    );
  }
  return result.stdout;
}

/**
 * Model discovery transports, newest CLI first. OpenCode v2 dropped the
 * positional provider argument and the `--verbose` flag from `opencode
 * models`, so each older call is kept as a fallback for v1 installs.
 */
const DISCOVERY_ATTEMPTS: readonly {
  label: string;
  dialect?: CliDialect;
  run: () => Promise<OpenCodeModelInfo[]>;
}[] = [
  {
    label: "opencode api GET /api/model",
    dialect: "v2",
    run: async () => {
      const args = ["api", "GET", "/api/model"];
      const first = parseApiModels(await captureOk(args));
      // A cold OpenCode service answers the first call with an empty model
      // list while it is still warming up, so retry once it has settled.
      if (first.length > 0) return first;
      await new Promise((resolve) => setTimeout(resolve, 400));
      return parseApiModels(await captureOk(args));
    },
  },
  {
    label: "opencode models opencode --verbose",
    dialect: "v1",
    run: async () =>
      parseVerboseModels(await captureOk(["models", "opencode", "--verbose"])),
  },
  {
    label: "opencode models",
    run: async () =>
      parseModelList(await captureOk(["models"])).map(fallbackModel),
  },
];

/** Build the install/setup instructions shown when the opencode CLI is unusable. */
export function setupGuidance(error: string): string {
  return [
    "opencode-pi could not use the local OpenCode CLI.",
    `Reason: ${error}`,
    "Install OpenCode (https://opencode.ai), ensure `opencode --version` works on PATH, then reload Pi.",
    "Set OPENCODE_PI_BIN to override the executable path.",
  ].join(" ");
}

/** Probe the OpenCode CLI with `opencode --version` to detect a missing/broken install. */
export async function checkCliStatus(): Promise<CliStatus> {
  try {
    const result = await runCapture(["--version"], undefined, STATUS_TIMEOUT_MS);
    if (result.code !== 0) {
      const detail =
        result.stderr.trim() ||
        result.stdout.trim() ||
        `opencode --version exited with code ${result.code}`;
      return { ok: false, summary: "OpenCode CLI is unusable", detail };
    }
    const version =
      result.stdout.trim() || result.stderr.trim() || "OpenCode CLI is available";
    const dialect = dialectOf(version);
    if (dialect) detectedCli = { bin: opencodeBin(), dialect };
    return { ok: true, summary: version };
  } catch (error) {
    return {
      ok: false,
      summary: "OpenCode CLI is unavailable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function discoverModels(opts?: {
  forceDiscovery?: boolean;
}): Promise<{
  models: OpenCodeModelInfo[];
  time: number;
  error: string | undefined;
}> {
  const configured = configuredModels();
  lastDiscoverySkipped = Boolean(configured?.length && !opts?.forceDiscovery);
  // An explicit OPENCODE_PI_MODELS list already tells us exactly which
  // models to register, so the fast (non-forced) path skips spawning
  // opencode entirely rather than making explicitly configured users pay a
  // discovery timeout on every startup when the binary is missing or slow.
  // `forceDiscovery` (used by the user-initiated /opencode-pi update
  // command) still runs discovery so configured models can be enriched with
  // real capability metadata (reasoning/image/limits) on request.
  if (configured?.length && !opts?.forceDiscovery) {
    lastDiscoveryError = undefined;
    return {
      models: dedupe(configured).map(fallbackModel),
      time: Date.now(),
      error: undefined,
    };
  }

  const errors: string[] = [];
  // The version picks the metadata call this CLI has; an unknown version
  // tries them all.
  const dialect = await cliDialect(opts?.forceDiscovery).catch(() => undefined);
  for (const attempt of DISCOVERY_ATTEMPTS) {
    if (dialect && attempt.dialect && attempt.dialect !== dialect) continue;
    try {
      const metadata = await attempt.run();
      if (metadata.length === 0) {
        throw new Error("discovery returned no models");
      }
      const byId = new Map(metadata.map((model) => [model.id, model]));
      const selected = configured?.length
        ? dedupe(configured).map((id) => byId.get(id) ?? fallbackModel(id))
        : metadata.filter(
            (model) => isActiveModel(model.status) && isFreeModel(model),
          );
      if (selected.length === 0) {
        throw new Error("discovery returned no free models");
      }

      if (!dialect && attempt.dialect) {
        detectedCli = { bin: opencodeBin(), dialect: attempt.dialect };
      }
      lastDiscoveryError = undefined;
      if (!configured?.length) await writeModelCache(selected).catch(() => undefined);
      return { models: selected, time: Date.now(), error: undefined };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errors.push(`${attempt.label}: ${conciseError(detail)}`);
    }
  }

  lastDiscoveryError = errors.join(" | ");
  const fallbackIds = configured?.length
    ? dedupe(configured)
    : DEFAULT_FREE_MODELS;
  return {
    models: fallbackIds.map(fallbackModel),
    time: Date.now(),
    error: lastDiscoveryError,
  };
}

async function refreshModels(
  pi: ExtensionAPI,
  ctx: { ui: { notify: (msg: string, level?: string) => void } },
): Promise<void> {
  const previousModels = new Set(registeredModels.map((model) => model.id));
  const { models, time, error } = await discoverModels({
    forceDiscovery: true,
  });
  registeredModels = models;
  lastDiscoveryTime = time;
  registerModels(pi);

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

/** Validate Pi images and turn them into OpenCode file parts. */
function imageFileParts(images: ImageContent[]) {
  return images.map((image, index) => {
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
    if (Buffer.from(base64, "base64").length === 0) {
      throw new Error(`Empty image data for image ${index + 1}`);
    }
    return {
      type: "file" as const,
      mime: image.mimeType,
      filename: `image-${String(index + 1).padStart(3, "0")}${safeImageExtension(image.mimeType)}`,
      url: `data:${image.mimeType};base64,${base64}`,
    };
  });
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function serializeMessage(message: TranscriptMessage): string {
  if (message.role === "user") {
    return `USER:\n${contentToText(message.content)}`;
  }

  if (message.role === "toolResult") {
    return [
      `TOOL RESULT (${message.toolName}, id=${message.toolCallId}, isError=${message.isError}):`,
      contentToText(message.content),
    ].join("\n");
  }

  const parts = message.content.map(
    (part: TextContent | ToolCall | { type: "thinking"; thinking: string }) => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking")
        return `<thinking>${part.thinking}</thinking>`;
      return `[called tool ${part.name} (id=${part.id}) with arguments ${JSON.stringify(part.arguments)}]`;
    },
  );
  return `ASSISTANT:\n${parts.join("\n")}`;
}

function serializeTools(tools: Tool[]): string {
  return safeJson(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  );
}

const BRIDGE_INSTRUCTIONS = `You are the model behind Pi Coding Agent, reached through the OpenCode CLI.
Your tools are Pi's tools. Pi runs every tool call and sends the result back in the next message.
Call tools with your normal tool calling. Never write a tool call out as text.
OpenCode's <env> block describes the bridge's scratch directory. Pi runs your tools in the working directory from Pi's system prompt.`;

function buildPrompt(context: BridgeContext): string {
  const sections = [`# Pi/OpenCode bridge instructions\n\n${BRIDGE_INSTRUCTIONS}`];
  if (context.systemPrompt.trim()) {
    sections.push(`# Pi system prompt\n\n${context.systemPrompt}`);
  }
  sections.push(
    `# Conversation transcript\n\n${
      context.messages.length > 0
        ? context.messages.map(serializeMessage).join("\n\n---\n\n")
        : "(no prior messages)"
    }`,
  );
  sections.push("Now produce the next assistant message for Pi.");
  return sections.join("\n\n---\n\n");
}

/**
 * Effective per-turn timeout: honor Pi's `timeoutMs` when it is a positive
 * finite number, otherwise fall back to the unconditional internal bound so
 * no turn can hang indefinitely (#73).
 */
export function resolveTurnTimeoutMs(timeoutMs: unknown): number {
  return typeof timeoutMs === "number" &&
    Number.isFinite(timeoutMs) &&
    timeoutMs > 0
    ? timeoutMs
    : DEFAULT_TURN_TIMEOUT_MS;
}

/**
 * Best-effort deletion of an OpenCode session record (#71). Fire-and-forget:
 * a failed delete is swallowed so it never fails the turn, and the spawned
 * helper is bounded by its own timeout.
 */
export function deleteOpenCodeSession(sessionId: string | undefined): void {
  if (!sessionId) return;
  try {
    const child = spawn(opencodeBin(), ["session", "delete", sessionId], {
      stdio: "ignore",
      env: { ...process.env, OPENCODE_DISABLE_UPDATE_CHECK: "1" },
      timeout: SESSION_DELETE_TIMEOUT_MS,
    });
    child.on("error", () => undefined);
    if (typeof child.unref === "function") child.unref();
  } catch {
    // Never fail the turn because session cleanup failed.
  }
}

export type PiSessionState = {
  /** Lazily created per-Pi-session OpenCode project directory (#74). */
  dirPromise?: Promise<string>;
  /** Recorded OpenCode session ID reused across turns (#75). */
  opencodeSessionId?: string;
  /** Model ID the recorded session was created with. */
  modelId?: string;
  /** Serialized tool list the recorded session was created with (#76). */
  toolsKey?: string;
  /** System prompt the recorded session was created with (#76). */
  systemPrompt?: string;
  /** Serialized transcript prefix already sent to the recorded session. */
  sentParts?: string[];
};

const piSessions = new Map<string, PiSessionState>();

/** Number of tracked Pi sessions (exposed for tests). */
export function trackedPiSessionCount(): number {
  return piSessions.size;
}

function getPiSessionState(piSessionId: string): PiSessionState {
  const existing = piSessions.get(piSessionId);
  if (existing) {
    // Refresh recency so eviction drops the least-recently-used entry.
    piSessions.delete(piSessionId);
    piSessions.set(piSessionId, existing);
    return existing;
  }
  const state: PiSessionState = {};
  piSessions.set(piSessionId, state);
  while (piSessions.size > MAX_TRACKED_PI_SESSIONS) {
    const oldest = piSessions.keys().next();
    if (oldest.done) break;
    void cleanupPiSessionState(oldest.value as string);
  }
  return state;
}

function ensurePiSessionDir(state: PiSessionState): Promise<string> {
  state.dirPromise ??= createTempAgentDir().catch((error) => {
    if (state.dirPromise) state.dirPromise = undefined;
    throw error;
  });
  return state.dirPromise;
}

/**
 * Remove a Pi session's project directory and delete its OpenCode session
 * record — the explicit cleanup path for session teardown (#74). With no
 * argument, every tracked session is cleaned up.
 */
export async function cleanupPiSessionState(
  piSessionId?: string,
): Promise<void> {
  const ids =
    piSessionId === undefined ? [...piSessions.keys()] : [piSessionId];
  await Promise.all(
    ids.map(async (id) => {
      const state = piSessions.get(id);
      if (!state) return;
      piSessions.delete(id);
      deleteOpenCodeSession(state.opencodeSessionId);
      state.opencodeSessionId = undefined;
      if (state.dirPromise) {
        const dirPromise = state.dirPromise;
        state.dirPromise = undefined;
        const dir = await dirPromise.catch(() => undefined);
        if (dir) await releaseDirectory(dir);
      }
    }),
  );
}

/** Forget a broken session so the next turn starts fresh (#75). */
function dropOpencodeSession(state: PiSessionState): void {
  deleteOpenCodeSession(state.opencodeSessionId);
  state.opencodeSessionId = undefined;
  state.modelId = undefined;
  state.toolsKey = undefined;
  state.systemPrompt = undefined;
  state.sentParts = undefined;
}

function serializedTranscriptParts(messages: TranscriptMessage[]): string[] {
  return messages.map(serializeMessage);
}

/**
 * Decide whether the next turn may continue the recorded OpenCode session
 * (#75, #76). Continuation requires the same model, the same serialized
 * tool list and system prompt, and a transcript that extends — never
 * rewrites — the previously sent prefix, with at least one new message.
 */
function continuationDelta(
  state: PiSessionState,
  modelId: string,
  context: BridgeContext,
  parts: string[],
): string[] | undefined {
  if (!state.opencodeSessionId) return undefined;
  if (state.modelId !== modelId) return undefined;
  if ((state.toolsKey ?? "") !== serializeTools(context.tools)) return undefined;
  if ((state.systemPrompt ?? "") !== (context.systemPrompt ?? "")) return undefined;
  const sent = state.sentParts ?? [];
  if (sent.length >= parts.length) return undefined;
  for (let index = 0; index < sent.length; index += 1) {
    if (sent[index] !== parts[index]) return undefined;
  }
  return parts.slice(sent.length);
}

function buildContinuationPrompt(deltaParts: string[]): string {
  return [
    "# Continued Pi/OpenCode bridge turn",
    "",
    "Pi handled the tool calls from your last step. OpenCode reports them as rejected only because Pi, not OpenCode, runs them. Their results are below, and your tools still work: keep calling them whenever the task needs another step.",
    "",
    "# New transcript since your last response",
    "",
    deltaParts.join("\n\n---\n\n"),
    "",
    "Now produce the next assistant message for Pi.",
  ].join("\n");
}

// OpenCode's free tier answers 403 unless the request declares a tool named
// `read`, so the bridge always declares one.
const REQUIRED_TOOL = "read";
// Custom tools ask for this permission, which the bridge rejects. The
// rejection ends OpenCode's step without running anything, and the finished
// tool part hands the call to Pi.
const PI_TOOL_PERMISSION = "pi_tool";
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// OpenCode gates these built-in tool IDs behind the first ID's permission.
const PERMISSION_GROUPS = [
  ["edit", "write", "apply_patch"],
  ["read", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"],
];

function permissionKey(name: string): string {
  return PERMISSION_GROUPS.find((group) => group.includes(name))?.[0] ?? name;
}

type JsonSchema = {
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  [key: string]: unknown;
};

function parameterSchema(tool: Tool): JsonSchema {
  // The JSON round trip drops TypeBox's symbol keys.
  const schema = JSON.parse(JSON.stringify(tool.parameters ?? {})) as JsonSchema;
  return schema && typeof schema === "object" ? schema : {};
}

/**
 * OpenCode marks every custom-tool argument as required, so optional Pi
 * arguments are declared nullable and the nulls are dropped again in
 * {@link piArguments}.
 */
export function openCodeToolArgs(tool: Tool): Record<string, JsonSchema> {
  const { properties = {}, required = [] } = parameterSchema(tool);
  return Object.fromEntries(
    Object.entries(properties).map(([name, schema]) => [
      name,
      required.includes(name)
        ? schema
        : {
            description: [schema.description, "Optional: pass null to leave it unset."].filter(Boolean).join(" "),
            anyOf: [schema, { type: "null" }],
          },
    ]),
  );
}

/** Keep only Pi's declared arguments, dropping nulls for optional ones. */
export function piArguments(tool: Tool, input: unknown): ToolCall["arguments"] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const { properties, required = [] } = parameterSchema(tool);
  const declared = properties && Object.keys(properties).length > 0 ? properties : undefined;
  return Object.fromEntries(
    Object.entries(input).filter(
      ([name, value]) =>
        (!declared || name in declared) && (value !== null || required.includes(name)),
    ),
  ) as ToolCall["arguments"];
}

/**
 * OpenCode only treats zod arguments as optional, so each Pi argument becomes
 * `z.any()` carrying its original JSON Schema as metadata. OpenCode installs
 * `@opencode-ai/plugin` (and its zod) into every project before it loads
 * custom tools. If that install failed, fall back to the nullable arguments.
 */
function piToolSource(tool: Tool): string {
  const { properties = {}, required = [] } = parameterSchema(tool);
  return `let z;
try {
  z = (await import("@opencode-ai/plugin")).tool.schema;
} catch {}
const properties = ${JSON.stringify(properties)};
const required = ${JSON.stringify(required)};
export default {
  description: ${JSON.stringify(tool.description ?? "")},
  args: z
    ? Object.fromEntries(Object.entries(properties).map(([name, schema]) => {
        const arg = z.any().meta(schema);
        return [name, required.includes(name) ? arg : arg.optional()];
      }))
    : ${JSON.stringify(openCodeToolArgs(tool))},
  async execute(_args, context) {
    await context.ask({ permission: ${JSON.stringify(PI_TOOL_PERMISSION)}, patterns: ["*"], always: [], metadata: {} });
    return "Pi runs this tool and sends the result in the next message.";
  },
};
`;
}

function unavailableToolSource(available: string[]): string {
  const message = available.length
    ? `Unavailable in this session. Use only these tools: ${available.join(", ")}.`
    : "Unavailable in this session. No tools are available.";
  return `export default {
  description: "Unavailable in this session. Do not call.",
  args: {},
  async execute() {
    return ${JSON.stringify(message)};
  },
};
`;
}

/**
 * Write the locked-down agent and one OpenCode custom tool per Pi tool. Every
 * OpenCode tool the agent can see is one of these files. Pi tools never run
 * inside OpenCode, and the unavailable stubs only return a message.
 */
export async function writeBridgeConfig(
  dir: string,
  tools: Tool[],
  dialect: CliDialect = "v1",
): Promise<void> {
  const piNames = tools.map((tool) => tool.name);
  const invalid = piNames.find((name) => !TOOL_NAME_PATTERN.test(name));
  if (invalid) {
    throw new Error(`Pi tool name ${JSON.stringify(invalid)} is not a valid OpenCode tool name.`);
  }
  const allowed = new Set([REQUIRED_TOOL, ...piNames].map(permissionKey));
  const declared = new Set([
    REQUIRED_TOOL,
    ...piNames,
    ...PERMISSION_GROUPS.filter((group) => allowed.has(group[0]!)).flat(),
  ]);

  const configDir = join(dir, ".opencode");
  const toolsDir = join(configDir, "tools");
  await rm(toolsDir, { recursive: true, force: true });
  await mkdir(join(configDir, "agents"), { recursive: true });
  await mkdir(toolsDir, { recursive: true });
  await Promise.all(
    [...declared].map((name) => {
      const tool = tools.find((candidate) => candidate.name === name);
      return writeFile(
        join(toolsDir, `${name}.js`),
        tool ? piToolSource(tool) : unavailableToolSource(piNames),
        "utf8",
      );
    }),
  );
  // v2 ignores custom tools and maps the `bash` key onto its own `shell`,
  // so it would run its built-in tools. Asking for everything makes `opencode
  // run` reject each call instead, which hands it to Pi.
  const permissions = dialect === "v2"
    ? [`  "*": ask`]
    : [
        `  "*": deny`,
        ...[...allowed].map((key) => `  ${JSON.stringify(key)}: allow`),
        `  ${JSON.stringify(PI_TOOL_PERMISSION)}: ask`,
      ];
  // OpenCode would spend a second request on the same model to title each
  // session. On the free tier that request shares, and hits, the rate limit.
  await writeFile(join(configDir, "agents", "title.md"), "---\ndisable: true\n---\n", "utf8");
  await writeFile(
    join(configDir, "agents", `${AGENT_ID}.md`),
    `---
description: Pi bridge agent. Its tools are Pi's tools, which Pi runs.
mode: primary
permission:
${permissions.join("\n")}
---
${BRIDGE_INSTRUCTIONS}
`,
    "utf8",
  );
}

function createTempAgentDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "opencode-pi-"));
}

// Serialized tool list last written to each project directory.
const configuredDirs = new Map<string, string>();

/**
 * Write the bridge config when the tool list changed. Returns true when the
 * server may still hold the directory's old config.
 */
async function syncBridgeConfig(dir: string, tools: Tool[], dialect: CliDialect): Promise<boolean> {
  const key = `${dialect}:${serializeTools(tools)}`;
  const previous = configuredDirs.get(dir);
  if (previous === key) return false;
  await writeBridgeConfig(dir, tools, dialect);
  configuredDirs.set(dir, key);
  return previous !== undefined;
}

/** Unload a project directory from the server and delete it. */
async function releaseDirectory(dir: string): Promise<void> {
  configuredDirs.delete(dir);
  const server = runningOpenCodeServer();
  if (server) {
    await serverRequest(server, "POST", "/instance/dispose", dir).catch(() => undefined);
  }
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Pi passes the prompt and tools as system messages in the transcript. Replay
 * them into the current prompt and tool list, and keep the rest as the
 * conversation the bridge serializes.
 */
function bridgeContext(context: Context): BridgeContext {
  const { messages } = normalizeContext(context);
  return {
    systemPrompt: getCurrentSystemPrompt(messages),
    tools: getCurrentTools(messages),
    messages: messages.filter(
      (message): message is TranscriptMessage => message.role !== "system",
    ),
  };
}

export function streamOpenCode(
  model: Model<Api>,
  rawContext: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const context = bridgeContext(rawContext);

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
    // Only one-shot turns own their directory. Per-Pi-session directories
    // persist for reuse and are removed at session teardown (#74). Release
    // it before the final event so the turn is fully done when Pi sees it.
    const releaseTempDir = async () => {
      const dir = tempDir;
      tempDir = undefined;
      if (dir) await releaseDirectory(dir);
    };
    let sessionId: string | undefined;
    let finishReason: "stop" | "length" = "stop";
    let opencodeError: string | undefined;
    let visibleText = "";
    let thinkingText = "";
    const toolCalls: ToolCall[] = [];
    // Per-Pi-session reuse key supplied by Pi core (stable for the life of
    // the Pi session). Without it, every turn runs an isolated fresh
    // session in its own temporary directory.
    const piSessionId =
      typeof options?.sessionId === "string" && options.sessionId
        ? options.sessionId
        : undefined;
    const piState = piSessionId ? getPiSessionState(piSessionId) : undefined;
    const transcriptParts = serializedTranscriptParts(context.messages);

    // One controller covers Pi's abort and the unconditional turn timeout
    // (#73). The abort listener is detached on every exit path (#72).
    const controller = new AbortController();
    const turnTimeoutMs = resolveTurnTimeoutMs(options?.timeoutMs);
    let timedOut = false;
    const abort = () => controller.abort();
    options?.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, turnTimeoutMs);

    // Text and reasoning stream as they arrive. Each OpenCode part becomes
    // one Pi content block, closed before the next block starts.
    const partTypes = new Map<string, string>();
    const partText = new Map<string, string>();
    const seenCalls = new Set<string>();
    let open: { partId: string; index: number } | undefined;

    const closeOpen = () => {
      if (!open) return;
      const contentIndex = open.index;
      const block = output.content[contentIndex];
      open = undefined;
      if (block?.type === "text") {
        stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
      } else if (block?.type === "thinking") {
        stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
      }
    };

    const appendDelta = (partId: string, kind: "text" | "thinking", delta: string) => {
      if (!delta) return;
      partText.set(partId, (partText.get(partId) ?? "") + delta);
      if (open?.partId !== partId) {
        closeOpen();
        open = { partId, index: output.content.length };
        output.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
        stream.push({ type: kind === "text" ? "text_start" : "thinking_start", contentIndex: open.index, partial: output });
      }
      const contentIndex = open.index;
      const block = output.content[contentIndex];
      if (block?.type === "text") {
        block.text += delta;
        visibleText += delta;
        stream.push({ type: "text_delta", contentIndex, delta, partial: output });
      } else if (block?.type === "thinking") {
        block.thinking += delta;
        thinkingText += delta;
        stream.push({ type: "thinking_delta", contentIndex, delta, partial: output });
      }
    };

    const blockKind = (type: string | undefined) =>
      type === "text" ? "text" : type === "reasoning" ? "thinking" : undefined;

    /** Handle one server event; returns true when the turn is finished. */
    const handleEvent = async (
      event: ServerEvent,
      reply: (path: string, body: unknown) => Promise<unknown>,
    ): Promise<boolean> => {
      const props = event.properties ?? {};

      if (event.type === "message.part.delta") {
        if (props.sessionID !== sessionId || props.field !== "text") return false;
        const kind = blockKind(partTypes.get(props.partID));
        if (kind && typeof props.delta === "string") appendDelta(props.partID, kind, props.delta);
        return false;
      }

      if (event.type === "message.part.updated") {
        const part = props.part;
        if (!part || part.sessionID !== sessionId) return false;
        partTypes.set(part.id, part.type);
        const kind = blockKind(part.type);
        if (kind && part.time?.end && typeof part.text === "string") {
          // The finished part carries its full text; emit anything the
          // deltas missed, then close its block.
          const seen = partText.get(part.id) ?? "";
          if (part.text.startsWith(seen)) appendDelta(part.id, kind, part.text.slice(seen.length));
          if (open?.partId === part.id) closeOpen();
          return false;
        }
        if (part.type === "step-finish") {
          if (/length|max.?tokens/i.test(String(part.reason ?? ""))) finishReason = "length";
          const tokens = part.tokens;
          if (!tokens) return false;
          output.usage.input = Number(tokens.input ?? 0);
          output.usage.output = Number(tokens.output ?? 0) + Number(tokens.reasoning ?? 0);
          output.usage.cacheRead = Number(tokens.cache?.read ?? 0);
          output.usage.cacheWrite = Number(tokens.cache?.write ?? 0);
          output.usage.totalTokens = Number(
            tokens.total ??
              output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite,
          );
          calculateCost(model, output.usage);
          return false;
        }
        // A Pi tool ends OpenCode's step through the rejected pi_tool ask,
        // so its finished tool part is a call for Pi to run. Calls to the
        // unavailable stubs already got their message inside OpenCode.
        if (part.type === "tool" && (part.state?.status === "completed" || part.state?.status === "error")) {
          const tool = context.tools.find((candidate) => candidate.name === part.tool);
          const id = typeof part.callID === "string" && part.callID ? part.callID : part.id;
          if (!tool || seenCalls.has(id)) return false;
          seenCalls.add(id);
          closeOpen();
          const toolCall: ToolCall = { type: "toolCall", id, name: tool.name, arguments: piArguments(tool, part.state.input) };
          const contentIndex = output.content.length;
          output.content.push(toolCall);
          toolCalls.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex, partial: output });
          stream.push({ type: "toolcall_delta", contentIndex, delta: safeJson(toolCall.arguments), partial: output });
          stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
        }
        return false;
      }

      if (event.type === "permission.asked" && props.sessionID === sessionId) {
        // Rejecting one ask rejects every pending ask in the session, so a
        // parallel call's ask can already be gone (404) by its turn.
        await reply(`/permission/${props.id}/reply`, { reply: "reject" }).catch((error: unknown) => {
          if (!/ failed with 404:/.test(String(error))) throw error;
        });
        return false;
      }

      if (event.type === "session.error" && props.sessionID === sessionId) {
        const message = props.error?.data?.message ?? props.error?.message ?? props.error?.name;
        opencodeError = typeof message === "string" && message.trim() ? message.trim() : safeJson(props.error);
        return false;
      }

      return (
        event.type === "session.status" &&
        props.sessionID === sessionId &&
        props.status?.type === "idle"
      );
    };

    try {
      stream.push({ type: "start", partial: output });
      if (options?.signal?.aborted) throw new Error("Request was aborted");

      // Continuation decision (#75, #76): reuse the recorded OpenCode
      // session only when the model, tools, system prompt, and transcript
      // prefix all still match. Any drift restarts fresh — and the stale
      // session record is deleted so it cannot leak.
      const delta = piState
        ? continuationDelta(piState, model.id, context, transcriptParts)
        : undefined;
      if (piState && piState.opencodeSessionId && delta === undefined) {
        dropOpencodeSession(piState);
      }
      const continuedSession = delta !== undefined ? piState?.opencodeSessionId : undefined;
      const prompt = delta !== undefined
        ? buildContinuationPrompt(delta)
        : buildPrompt(context);
      const sentMessages = delta !== undefined
        ? context.messages.slice(transcriptParts.length - delta.length)
        : context.messages;

      const sessionDir = piState
        ? await ensurePiSessionDir(piState)
        : await createTempAgentDir().then((dir) => {
            tempDir = dir;
            return dir;
          });
      const dialect = await cliDialect();
      const staleInstance = await syncBridgeConfig(sessionDir, context.tools, dialect);
      if (options?.signal?.aborted) throw new Error("Request was aborted");
      const files = imageFileParts(
        imageContentsForModel(sentMessages, model.input.includes("image")),
      );
      if (options?.signal?.aborted) throw new Error("Request was aborted");
      const reasoning = (options?.reasoning as ModelThinkingLevel | undefined) ?? "off";
      const variant = model.thinkingLevelMap?.[reasoning];
      const slash = model.id.indexOf("/");
      const body = {
        agent: AGENT_ID,
        model: slash > 0
          ? { providerID: model.id.slice(0, slash), modelID: model.id.slice(slash + 1) }
          : { providerID: "opencode", modelID: model.id },
        ...(typeof variant === "string" && variant.trim() ? { variant } : {}),
        parts: [...files, { type: "text", text: prompt }],
      };

      const turnStopped = () =>
        new Error(timedOut ? `opencode timed out after ${turnTimeoutMs}ms` : "Request was aborted");

      // OpenCode v2's server speaks a different API, so v2 turns still run
      // through `opencode run`, which only reports finished parts.
      const runStandalone = async () => {
        const args = [
          "run", "--standalone",
          "-m", typeof variant === "string" && variant.trim() && !model.id.includes("#") ? `${model.id}#${variant}` : model.id,
          "--agent", AGENT_ID, "--format", "json",
        ];
        if (continuedSession) args.push("--session", continuedSession);
        if (reasoning !== "off") args.push("--thinking");
        const imageDir = join(sessionDir, "pi-images");
        if (files.length > 0) await mkdir(imageDir, { recursive: true });
        for (const file of files) {
          const path = join(imageDir, file.filename);
          await writeFile(path, Buffer.from(file.url.slice(file.url.indexOf(",") + 1), "base64"));
          args.push("--file", path);
        }
        // Abort events are not replayed, so a turn stopped during setup must
        // not start the run at all.
        if (controller.signal.aborted) throw turnStopped();
        const child = spawn(opencodeBin(), args, {
          cwd: sessionDir,
          stdio: ["pipe", "pipe", "pipe"],
          // v2 resolves the project from PWD, which spawn leaves at Pi's cwd.
          env: { ...process.env, PWD: sessionDir, OPENCODE_DISABLE_UPDATE_CHECK: "1" },
        });
        const kill = () => child.kill("SIGTERM");
        controller.signal.addEventListener("abort", kill, { once: true });
        const partTypeByEvent: Record<string, string> = {
          text: "text", reasoning: "reasoning", tool_use: "tool", step_finish: "step-finish",
        };
        let stderr = "";
        let remainder = "";
        let lineCount = 0;
        // v2 answers a rejected ask to the model and keeps going, so the run
        // ends once the step holding Pi's tool calls finishes.
        let handedOff = false;
        const handleLine = (line: string) => {
          if (handedOff || !line.trim()) return;
          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            stderr = (stderr + `\n${line}`).slice(-STDERR_LIMIT);
            return;
          }
          if (typeof event.sessionID === "string" && event.sessionID) sessionId ??= event.sessionID;
          const type = partTypeByEvent[event.type];
          if (type) {
            // v2 tool parts carry the call ID as `id` and the part ID as `partID`.
            const part = event.part ?? {};
            void handleEvent({
              type: "message.part.updated",
              properties: {
                part: {
                  ...part,
                  type,
                  sessionID: sessionId,
                  id: part.partID ?? part.id ?? `${event.type}-${lineCount++}`,
                  callID: part.callID ?? part.id,
                  // v2's built-in shell is Pi's bash.
                  ...(part.tool === "shell" ? { tool: "bash" } : {}),
                  time: { ...part.time, end: part.time?.end ?? Date.now() },
                },
              },
            }, async () => undefined);
            if (type === "step-finish" && toolCalls.length > 0) {
              handedOff = true;
              child.kill("SIGTERM");
            }
          } else if (event.type === "error") {
            void handleEvent({ type: "session.error", properties: { sessionID: sessionId, error: event.error } }, async () => undefined);
          }
        };
        child.stdin!.end(prompt);
        child.stdout!.setEncoding("utf8");
        child.stderr!.setEncoding("utf8");
        child.stdout!.on("data", (chunk: string) => {
          const lines = (remainder + chunk).split(/\r?\n/);
          remainder = lines.pop() ?? "";
          for (const line of lines) handleLine(line);
        });
        child.stderr!.on("data", (chunk: string) => {
          stderr = (stderr + chunk).slice(-STDERR_LIMIT);
        });
        const code = await new Promise<number | null>((resolve, reject) => {
          child.on("error", reject);
          child.on("close", resolve);
        }).finally(() => controller.signal.removeEventListener("abort", kill));
        handleLine(remainder);
        if (controller.signal.aborted) throw turnStopped();
        if (code !== 0 && !opencodeError && !handedOff) {
          throw new Error(stderr.trim() || `opencode exited with code ${code}`);
        }
      };

      if (dialect === "v2") await runStandalone();
      else await withOpenCodeServer(
        opencodeBin(),
        { ...process.env, OPENCODE_DISABLE_UPDATE_CHECK: "1" },
        async (server) => {
          const request = (method: string, path: string, payload?: unknown) =>
            serverRequest(server, method, path, sessionDir, payload, controller.signal);
          try {
            // A changed tool list rewrote the config; reload the instance.
            if (staleInstance) await request("POST", "/instance/dispose");
            const events = await subscribeEvents(server, sessionDir, controller.signal);
            try {
              sessionId = continuedSession ?? (await request("POST", "/session", {}))?.id;
              if (typeof sessionId !== "string") throw new Error("OpenCode did not return a session ID");
              await request("POST", `/session/${sessionId}/prompt_async`, body);
              let finished = false;
              for await (const event of events) {
                if (await handleEvent(event, (path, payload) => request("POST", path, payload))) {
                  finished = true;
                  break;
                }
              }
              if (!finished) throw new Error("OpenCode event stream ended before the turn finished");
            } finally {
              await events.return(undefined).catch(() => undefined);
            }
          } catch (error) {
            if (!controller.signal.aborted) throw error;
            if (sessionId) {
              await serverRequest(server, "POST", `/session/${sessionId}/abort`, sessionDir).catch(() => undefined);
            }
            throw turnStopped();
          }
        },
      );
      closeOpen();

      if (opencodeError) throw new Error(opencodeError);
      if (toolCalls.length === 0 && !visibleText.trim() && !thinkingText.trim()) {
        throw new Error(
          `OpenCode returned an empty assistant response (${visibleText ? `whitespace-only text, length=${visibleText.length}` : "no text"}). This can happen with some free models when the prompt is too long, the model times out, or the model is overloaded. Retry the request or select another OpenCode model.`,
        );
      }
      setEstimatedUsage(model, output, prompt, visibleText + thinkingText);

      // The turn succeeded: record the session for reuse, or delete the
      // one-shot session record so it cannot accumulate (#71, #75). This
      // reply is already in the OpenCode session, so it counts as sent.
      if (piState) {
        piState.opencodeSessionId = sessionId;
        piState.modelId = model.id;
        piState.toolsKey = serializeTools(context.tools);
        piState.systemPrompt = context.systemPrompt;
        piState.sentParts = [...transcriptParts, serializeMessage(output)];
      } else {
        deleteOpenCodeSession(sessionId);
      }

      const reason = toolCalls.length > 0 ? "toolUse" : finishReason;
      output.stopReason = reason;
      await releaseTempDir();
      stream.push({ type: "done", reason, message: output });
      stream.end();
    } catch (error) {
      closeOpen();
      // Any error, timeout, or abort drops the session ID so the next turn
      // starts fresh with the full transcript; the failed session record is
      // deleted best-effort and never fails the turn (#71, #75).
      deleteOpenCodeSession(sessionId);
      if (piState) dropOpencodeSession(piState);
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage =
        error instanceof Error ? error.message : String(error);
      // Ensure output.content has text so downstream tools (model-debugger,
      // Pi agent) see real content instead of flagging a "silent failure."
      if (output.content.length === 0) {
        output.content.push({ type: "text", text: `Error: ${output.errorMessage}` });
      }
      await releaseTempDir();
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", abort);
      await releaseTempDir();
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
    "OpenCode tools are disabled; Pi's tools are passed through as OpenCode custom tools that Pi runs.",
  );
  lines.push(
    "Run /opencode-pi update to refresh the model list from opencode.",
  );
  return lines;
}

function registerApiHandler(): void {
  registerApiProvider(
    {
      api: API_ID,
      stream: (model, context, options) =>
        streamOpenCode(model, context, options),
      streamSimple: streamOpenCode,
    },
    PROVIDER_ID,
  );
}

function registerModels(pi: ExtensionAPI): void {
  try {
    pi.registerProvider(PROVIDER_ID, {
      name: "OpenCode CLI",
      baseUrl: "cli:opencode",
      apiKey: "opencode-cli-no-api-key",
      api: API_ID,
      models: registeredModels.map(providerModel),
      streamSimple: streamOpenCode,
    });
  } catch {
    // registerProvider may reject if already registered; the models array is already updated.
  }
  registerApiHandler();
}

let startupCheck: Promise<CliStatus> = Promise.resolve({ ok: true, summary: "" });

/** Settles once the background CLI check and model discovery finish. */
export function whenStartupChecked(): Promise<CliStatus> {
  return startupCheck;
}

async function checkCliAndDiscover(pi: ExtensionAPI): Promise<CliStatus> {
  const status = await checkCliStatus();
  lastCliAvailable = status.ok;
  if (!status.ok) return status;
  const { models, time } = await discoverModels();
  lastDiscoveryTime = time;
  if (JSON.stringify(models) !== JSON.stringify(registeredModels)) {
    registeredModels = models;
    registerModels(pi);
  }
  return status;
}

export default async function opencodePiExtension(pi: ExtensionAPI) {
  // Register the last discovered models (or the defaults) right away and
  // ask the CLI in the background, so loading Pi never waits on OpenCode.
  const known = configuredModels()?.length
    ? (await discoverModels()).models
    : await readModelCache();
  registeredModels = known ?? DEFAULT_FREE_MODELS.map(fallbackModel);
  registerModels(pi);
  startupCheck = checkCliAndDiscover(pi);
  // The first start has no cache, and Pi may ask for a model only
  // discovery knows, so that one start waits.
  if (!known) await startupCheck;

  // Tear down per-Pi-session OpenCode state — project directories and
  // session records — when the Pi session ends for any reason (#74).
  pi.on("session_shutdown", () => {
    void cleanupPiSessionState();
  });

  pi.on("session_start", (_event: any, ctx: any) => {
    void startupCheck.then((cliStatus) => notifyStartup(ctx, cliStatus));
  });

  function notifyStartup(ctx: any, cliStatus: CliStatus): void {
    if (!cliStatus.ok) {
      const fastPathConfigured = Boolean(configuredModels()?.length);
      const fastPathNote = fastPathConfigured
        ? "OPENCODE_PI_MODELS skipped discovery, so this was not detected at startup. "
        : "";
      ctx.ui.notify(
        `opencode-pi: ${fastPathNote}${setupGuidance(cliStatus.detail ?? cliStatus.summary)}`,
        "warning",
      );
      return;
    }
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
  }

  pi.registerCommand("opencode-pi", {
    description: "OpenCode CLI bridge status and setup help",
    handler: async (args: string, ctx: any) => {
      const trimmedArgs = args.trim();
      if (trimmedArgs.length === 0 && ctx.mode === "tui" && ctx.hasUI) {
        await showOpenCodePanel(ctx);
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
