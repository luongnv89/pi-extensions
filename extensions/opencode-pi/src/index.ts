import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  calculateCost,
  createAssistantMessageEventStream,
  registerApiProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type ModelThinkingLevel,
  type SimpleStreamOptions,
  type ThinkingLevelMap,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  runningOpenCodeServer,
  serverRequest,
  subscribeEvents,
  withOpenCodeServer,
  type OpenCodeServer,
  type ServerEvent,
} from "./server.js";

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
  "opencode/beam-free",
  "opencode/big-pickle",
  "opencode/deepseek-v4.1-flash-free",
  "opencode/glm-5.3-flash-free",
  "opencode/longcat-2.5-preview-free",
  "opencode/mimo-v2.6-flash-free",
  "opencode/minimax-m3.1-flash-free",
  "opencode/nemotron-3-ultra-free",
  "opencode/nemotron-3.5-lightning-free",
  "opencode/nemotron-3.5-super-vl-free",
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

export type ParsedToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export type ToolCallParseResult =
  | { ok: true; calls: ParsedToolCall[]; cleanedText?: string }
  | {
      ok: false;
      rejection:
        | { reason: "malformed_markers" }
        | { reason: "invalid_payload" }
        | { reason: "unavailable_tool"; toolName: string };
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
        `OPENCODE_PI_STREAM: ${panelEnvState("OPENCODE_PI_STREAM")}`,
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

/** OpenCode v1 turns stream through `opencode serve` unless OPENCODE_PI_STREAM is off. */
function streamingEnabled(): boolean {
  return !/^(0|off|false|no)$/i.test(process.env.OPENCODE_PI_STREAM?.trim() ?? "");
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

async function refreshModels(pi: ExtensionAPI): Promise<string> {
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
  return msg;
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

/**
 * A content block of a Pi message, described loosely so Pi 0.x messages,
 * Pi 1.x messages, and malformed provider payloads all fit the same shape.
 */
type MessageContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  mimeType?: string;
  data?: string;
};

/**
 * Normalize a message payload into an array of content blocks.
 *
 * Pi 1.x system messages carry a plain string, and streamed provider output
 * can deliver `null`, `undefined`, or a single object instead of an array.
 * Every content accessor goes through this helper, so a malformed message can
 * never crash a turn (#119, #129).
 */
export function normalizeContent(content: unknown): MessageContentBlock[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) {
    return content.filter(
      (item: unknown) => typeof item === "object" && item !== null,
    ) as MessageContentBlock[];
  }
  if (typeof content === "object") return [content as MessageContentBlock];
  return [];
}

/**
 * A Pi message as the bridge sees it, tolerant of the Pi 0.x and Pi 1.x
 * message shapes.
 */
type BridgeMessage = {
  role?: string;
  content?: unknown;
  toolsAdded?: unknown;
  toolsRemoved?: unknown;
  sections?: unknown;
};

function bridgeMessages(messages: unknown): BridgeMessage[] {
  return Array.isArray(messages) ? (messages as BridgeMessage[]) : [];
}

function isSystemMessage(message: BridgeMessage): boolean {
  return message.role === "system";
}

/**
 * Conversation messages, with the Pi 1.x system messages removed.
 *
 * System messages carry the prompt and the tool declarations; they are
 * rendered as their own prompt sections instead of transcript entries.
 */
export function conversationMessages(messages: unknown): Message[] {
  return bridgeMessages(messages).filter(
    (message) => !isSystemMessage(message),
  ) as Message[];
}

/**
 * Tool declarations replayed from the transcript's system messages (Pi 1.x).
 *
 * The leading system message declares the tools; later system messages add or
 * remove them by name.
 */
export function transcriptTools(messages: unknown): Tool[] {
  const tools = new Map<string, Tool>();
  for (const message of bridgeMessages(messages)) {
    if (!isSystemMessage(message)) continue;
    for (const removed of (message.toolsRemoved as
      | { name?: unknown }[]
      | undefined) ?? []) {
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
 *
 * Every system message contributes its text; named sections are patched by
 * name (a `null` section removes it) and the surviving sections are appended.
 */
export function transcriptSystemPrompt(messages: unknown): string {
  const contents: string[] = [];
  const sections = new Map<string, string>();
  for (const message of bridgeMessages(messages)) {
    if (!isSystemMessage(message)) continue;
    const text = contentToText(message.content);
    if (text.length > 0) contents.push(text);
    const declared = (message.sections ?? {}) as Record<string, unknown>;
    for (const [name, value] of Object.entries(declared)) {
      if (value === null) sections.delete(name);
      else if (typeof value === "string") sections.set(name, value);
    }
  }
  return [...contents, ...sections.values()]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

/**
 * Tools available for the current turn.
 *
 * Pi 1.x hands providers a normalized transcript whose system messages carry
 * the tool declarations, so `context.tools` is empty there. Pi 0.x passes the
 * declarations on the context. The transcript wins whenever it carries a
 * system message (#140).
 */
export function resolveTurnTools(context: Context): Tool[] {
  const messages = bridgeMessages(context?.messages);
  if (messages.some(isSystemMessage)) return transcriptTools(messages);
  return context?.tools ?? [];
}

/**
 * System prompt for the current turn, from the transcript when it carries one
 * and from the legacy context otherwise (#140).
 */
export function resolveTurnSystemPrompt(context: Context): string {
  const messages = bridgeMessages(context?.messages);
  if (messages.some(isSystemMessage)) return transcriptSystemPrompt(messages);
  return context?.systemPrompt ?? "";
}

function contentToText(content: unknown): string {
  return normalizeContent(content)
    .map((item) => {
      if (item.type === "text") return typeof item.text === "string" ? item.text : "";
      if (item.type === "image") {
        const size = typeof item.data === "string" ? item.data.length : 0;
        return `[image in conversation: ${item.mimeType}, ${size} base64 chars]`;
      }
      return "";
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
    for (const content of normalizeContent(message.content)) {
      if (content.type === "image") images.push(content as ImageContent);
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

  const parts = normalizeContent(message.content).map((part) => {
    if (part.type === "text") {
      return typeof part.text === "string" ? part.text : "";
    }
    if (part.type === "thinking") {
      return `<thinking>${part.thinking ?? ""}</thinking>`;
    }
    return `<pi_tool_call>${safeJson({ id: part.id, name: part.name, arguments: part.arguments })}</pi_tool_call>`;
  });
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
OpenCode's <env> block describes the bridge's scratch directory. Pi runs your tools in the working directory from Pi's system prompt.

If you need Pi to run a tool, your entire response must contain only one or more tool-call blocks separated by whitespace:
<pi_tool_call>{"name":"tool_name","arguments":{}}</pi_tool_call>

Rules for Pi tool calls:
- Use only exact tool names listed in the "Available Pi tools" section.
- A "read" tool may appear in your own tool list. It belongs to OpenCode, not to Pi, and it is disabled in this session. Never call it; ask Pi for the file instead.
- The JSON inside every marker must be valid JSON with a string "name" and an object "arguments".
- Escape every quote inside a JSON string value as \\\", especially quotes inside shell commands.
- Markers are bridge control syntax. Never quote them, explain them, put them in prose, or wrap them in Markdown fences.
- Never output a marker as an example. A marker means you are requesting immediate execution.
- Do not put any text before or after tool-call markers. Mixed prose and markers will not execute.
- NEVER use XML-style tool-use syntax (e.g., <bash>, <read>, <glob>, <grep>, <edit>, <task>, <arg_key>, <arg_value>). These are your native tool-use format and are completely disabled.
- NEVER use Claude Code XML-style markup (e.g., <bash command="...">, <read path="...">, <arg_key>, <arg_value>). This is not a tool-call and will be treated as plain text.
- If you can answer without a tool, answer normally in plain text and do not emit any marker.
- After Pi returns tool results, match them to prior tool-call IDs in the transcript, then either answer or request another Pi tool call.`);

  const systemPrompt = resolveTurnSystemPrompt(context);
  if (systemPrompt.trim()) {
    sections.push(`# Pi system prompt

${systemPrompt}`);
  }

  sections.push(`# Available Pi tools

${serializeTools(resolveTurnTools(context))}`);

  const conversation = conversationMessages(context.messages);
  if (conversation.length > 0) {
    sections.push(`# Conversation transcript

${conversation.map(serializeMessage).join("\n\n---\n\n")}`);
  } else {
    sections.push("# Conversation transcript\n\n(no prior messages)");
  }

  sections.push("Now produce the next assistant message for Pi.");
  return sections.join("\n\n---\n\n");
}

const MARKER_OPEN = "<pi_tool_call>";

// Detects marker syntax anywhere in the response, not just at the start, so
// prose-then-marker and marker-then-prose responses are treated the same
// way: either both are rejected as malformed tool-call attempts, or neither
// is. A one-sided check let malformed leading prose silently leak raw
// marker text into the visible chat response while malformed trailing prose
// hard-failed the turn.
//
// Requires the opening marker specifically: a response can only be
// *attempting* a tool call if it emits the open tag. A lone closing marker
// (e.g. prose that merely quotes or discusses `</pi_tool_call>`) is not a
// plausible tool-call attempt and must not hard-fail the turn.
export function isToolCallMarkerResponse(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.includes(MARKER_OPEN);
}

type MarkerClose = { index: number; length: number };

// Models occasionally vary whitespace, separators, plurality, or case in the
// closing tag. Keep the opening marker strict, but accept this bounded family
// of unmistakable Pi marker closers.
const MARKER_CLOSE_PATTERN = /^<\s*\/\s*pi[-_]tool[-_]calls?\s*>/i;

// A closing marker inside a JSON string (e.g. tool arguments that happen to
// contain the literal text "</pi_tool_call>") must not be treated as the
// real boundary, so this walks the JSON string-escaping state rather than
// matching the close tag with a plain regex.
function findMarkerClose(text: string, from: number): MarkerClose | undefined {
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
    if (char !== "<") continue;
    const match = text.slice(i).match(MARKER_CLOSE_PATTERN);
    if (match) return { index: i, length: match[0].length };
  }
  return undefined;
}

// Some models emit a complete marker payload but omit or garble the closing
// tag, and often follow it with an invented tool result. Recover the payload
// by locating one complete top-level JSON object or array; the caller strips
// whatever follows it. Truncated JSON is never recovered, and payload
// validation and the current-turn tool allowlist are still applied.
function recoverUnclosedMarkerBody(
  text: string,
  bodyStart: number,
): string | undefined {
  let start = bodyStart;
  while (/\s/.test(text[start] ?? "")) start++;
  const first = text[start];
  if (first !== "{" && first !== "[") return undefined;

  const stack: string[] = [first];
  let inString = false;
  let escaped = false;
  for (let i = start + 1; i < text.length; i++) {
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
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char !== "}" && char !== "]") continue;

    const expected = char === "}" ? "{" : "[";
    if (stack.pop() !== expected) return undefined;
    if (stack.length === 0) return text.slice(bodyStart, i + 1);
  }
  return undefined;
}

function normalizeQuotedToolCallResponse(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return text;
  try {
    const decoded: unknown = JSON.parse(trimmed);
    return typeof decoded === "string" && decoded.includes(MARKER_OPEN)
      ? decoded
      : text;
  } catch {
    return text;
  }
}

/**
 * Extract <pi_tool_call> marker bodies from the response text.
 * Lenient: markers are extracted anywhere in the text, even with prose
 * before or after them, matching how real models behave. A marker whose
 * payload cannot be recovered (truncated JSON) is recorded as an invalid span instead of aborting extraction,
 * so valid sibling markers still parse and the unrecoverable text can be
 * stripped from the displayed response (#39).
 */
type MarkerSpan = { start: number; end: number };

type ExtractedMarker = { body: string; start: number; end: number };

type MarkerExtraction = {
  markers: ExtractedMarker[];
  invalidSpans: MarkerSpan[];
};

function toolCallMarkers(text: string): MarkerExtraction | undefined {
  const trimmed = text.trim();
  const markers: ExtractedMarker[] = [];
  const invalidSpans: MarkerSpan[] = [];
  let cursor = 0;
  while (cursor < trimmed.length) {
    const openIndex = trimmed.indexOf(MARKER_OPEN, cursor);
    if (openIndex === -1) break;

    const bodyStart = openIndex + MARKER_OPEN.length;
    const close = findMarkerClose(trimmed, bodyStart);
    if (close) {
      markers.push({
        body: trimmed.slice(bodyStart, close.index),
        start: openIndex,
        end: close.index + close.length,
      });
      cursor = close.index + close.length;
      continue;
    }

    const recovered = recoverUnclosedMarkerBody(trimmed, bodyStart);
    if (recovered !== undefined) {
      // Without a closing tag, everything up to the next opening marker
      // belongs to this attempt (a garbled closer or an invented result).
      const nextOpen = trimmed.indexOf(MARKER_OPEN, bodyStart + recovered.length);
      const end = nextOpen === -1 ? trimmed.length : nextOpen;
      markers.push({ body: recovered, start: openIndex, end });
      cursor = end;
      continue;
    }

    // Unrecoverable marker: everything up to the next opening marker (or
    // the end of the response) is inside the attempted marker, so strip it.
    const nextOpen = trimmed.indexOf(MARKER_OPEN, bodyStart);
    const spanEnd = nextOpen === -1 ? trimmed.length : nextOpen;
    invalidSpans.push({ start: openIndex, end: spanEnd });
    cursor = spanEnd;
  }
  if (markers.length === 0 && invalidSpans.length === 0) return undefined;
  return { markers, invalidSpans };
}

function stripMarkerSpans(text: string, spans: MarkerSpan[]): string {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let cleaned = "";
  let cursor = 0;
  for (const span of sorted) {
    if (span.start < cursor) continue;
    cleaned += text.slice(cursor, span.start);
    cursor = Math.max(cursor, span.end);
  }
  cleaned += text.slice(cursor);
  return cleaned;
}

/** Streams reply text without ever releasing a Pi tool-call marker. */
export type MarkerStreamFilter = {
  /** Everything pushed so far. */
  readonly text: string;
  /** Add a delta; returns the text that is now safe to show. */
  push(delta: string): string;
  /**
   * End the reply; returns the held text that is still safe to show.
   * `displayText` is the parsed reply's display text, released whole when
   * the reply was held as a JSON-quoted string.
   */
  finish(displayText: string): string;
};

/**
 * Text is released as soon as it cannot start a `<pi_tool_call>` marker. A
 * marker is held until its closing tag arrives and is then skipped, and an
 * unclosed marker holds everything after it until the reply ends, so raw
 * markers never stream into Pi. A reply that opens with a quote may be a
 * JSON-quoted marker response, so it is held whole.
 */
export function createMarkerStreamFilter(): MarkerStreamFilter {
  let text = "";
  let released = 0;
  let quoted: boolean | undefined;

  const drain = (): string => {
    if (quoted === undefined) {
      const start = text.trimStart();
      if (!start) return "";
      quoted = start.startsWith('"');
    }
    if (quoted) return "";
    let out = "";
    while (true) {
      const open = text.indexOf(MARKER_OPEN, released);
      if (open === -1) {
        // Hold a trailing prefix of the opening marker.
        let held = Math.min(MARKER_OPEN.length - 1, text.length - released);
        while (held > 0 && !MARKER_OPEN.startsWith(text.slice(text.length - held))) {
          held -= 1;
        }
        out += text.slice(released, text.length - held);
        released = text.length - held;
        return out;
      }
      out += text.slice(released, open);
      released = open;
      const close = findMarkerClose(text, open + MARKER_OPEN.length);
      if (!close) return out;
      released = close.index + close.length;
    }
  };

  return {
    get text() {
      return text;
    },
    push(delta: string): string {
      text += delta;
      return drain();
    },
    finish(displayText: string): string {
      if (quoted) return displayText;
      const rest = text.slice(released);
      return rest.startsWith(MARKER_OPEN) ? "" : rest;
    },
  };
}

export function parseToolCallResponse(
  text: string,
  allowedToolNames?: ReadonlySet<string>,
): ToolCallParseResult {
  const normalizedText = normalizeQuotedToolCallResponse(text);
  if (!isToolCallMarkerResponse(normalizedText)) return { ok: true, calls: [] };

  const extraction = toolCallMarkers(normalizedText);
  if (!extraction) return { ok: true, calls: [] };

  const parsed: ParsedToolCall[] = [];
  const strippedSpans: MarkerSpan[] = [...extraction.invalidSpans];
  let payloadRejection:
    | { reason: "invalid_payload" }
    | undefined;

  for (const marker of extraction.markers) {
    let calls = parseToolCallJson(marker.body);
    if (calls.length === 0) {
      // A closed marker can still carry junk after a complete payload, such
      // as a literal "\n" before the closing tag; drop it like an unclosed
      // marker's trailing text.
      const payload = recoverUnclosedMarkerBody(marker.body, 0);
      if (payload !== undefined && payload.trim() !== marker.body.trim()) {
        calls = parseToolCallJson(payload);
      }
    }
    if (calls.length === 0) {
      // Skip the invalid body but keep any valid sibling calls; if no
      // call survives, surface the original corrective diagnostic.
      payloadRejection ??= { reason: "invalid_payload" };
      strippedSpans.push({ start: marker.start, end: marker.end });
      continue;
    }
    const unavailable = calls.find(
      (call) => allowedToolNames && !allowedToolNames.has(call.name),
    );
    if (unavailable) {
      return {
        ok: false,
        rejection: {
          reason: "unavailable_tool",
          toolName: unavailable.name,
        },
      };
    }
    parsed.push(...calls);
  }

  if (parsed.length === 0 && payloadRejection) {
    return { ok: false, rejection: payloadRejection };
  }

  if (strippedSpans.length === 0) return { ok: true, calls: parsed };
  return {
    ok: true,
    calls: parsed,
    cleanedText: stripMarkerSpans(normalizedText, strippedSpans),
  };
}

export function parseToolCalls(
  text: string,
  allowedToolNames?: ReadonlySet<string>,
): ParsedToolCall[] {
  const result = parseToolCallResponse(text, allowedToolNames);
  return result.ok ? result.calls : [];
}

/**
 * Detects if the model response contains XML-style tool-use markup
 * (e.g., Claude Code's <bash>, <read>, <arg_key>, <arg_value> tags).
 * Returns the detected tool name if found, or undefined if not.
 */
function detectXmlToolUse(text: string): string | undefined {
  // Match XML-style tool tags that look like tool invocations.
  // These are NOT <pi_tool_call> markers — they are the model's native format.
  // Claude Code uses <bash>, <read>, <edit>, etc. directly, but may also
  // emit <arg_key>/<arg_value> pairs inside those tags.
  const xmlToolPattern = /<(bash|read|edit|write|glob|grep|ls|webfetch|websearch|task|todowrite|question|skill|lsp|external_directory|doom_loop|agent|arg_key|arg_value)\b/i;
  const match = text.match(xmlToolPattern);
  return match ? match[1].toLowerCase() : undefined;
}

function toolCallRejectionMessage(
  result: Extract<ToolCallParseResult, { ok: false }>,
  allowedToolNames: ReadonlySet<string>,
): string {
  switch (result.rejection.reason) {
    case "malformed_markers":
      return "OpenCode returned malformed Pi tool-call markers. Ensure each marker contains valid JSON with a string \"name\" and object \"arguments\".";
    case "invalid_payload":
      return 'OpenCode returned an invalid Pi tool-call payload. Each marker must contain valid JSON with a non-empty string "name" and object "arguments".';
    case "unavailable_tool": {
      const available = [...allowedToolNames].map((name) =>
        JSON.stringify(name),
      );
      return `OpenCode requested unavailable Pi tool ${JSON.stringify(result.rejection.toolName)}. Use only tools available in the current Pi turn: ${available.length > 0 ? available.join(", ") : "none"}.`;
    }
  }
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

function repairUnescapedJsonStringQuotes(raw: string): string | undefined {
  const trimmed = raw.trim();
  const matchingContainer =
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));
  if (!matchingContainer) return undefined;

  let repaired = "";
  let inString = false;
  let escaped = false;
  let changed = false;

  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index];
    if (!inString) {
      repaired += char;
      if (char === '"') inString = true;
      continue;
    }
    if (escaped) {
      repaired += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      repaired += char;
      escaped = true;
      continue;
    }
    if (char !== '"') {
      repaired += char;
      continue;
    }

    let nextIndex = index + 1;
    while (/\s/.test(trimmed[nextIndex] ?? "")) nextIndex++;
    const next = trimmed[nextIndex];
    if (next === undefined || [",", ":", "}", "]"].includes(next)) {
      repaired += char;
      inString = false;
    } else {
      repaired += '\\"';
      changed = true;
    }
  }

  return changed && !inString ? repaired : undefined;
}

function parseToolCallJson(raw: string): ParsedToolCall[] {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    const repaired = repairUnescapedJsonStringQuotes(raw);
    if (!repaired) return [];
    try {
      value = JSON.parse(repaired);
    } catch {
      return [];
    }
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

function ensurePiSessionDir(
  state: PiSessionState,
  dialect: CliDialect,
): Promise<string> {
  state.dirPromise ??= createTempAgentDir(dialect).catch((error) => {
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
        if (dir) await removeSessionDir(dir);
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

function serializedTranscriptParts(messages: Message[]): string[] {
  return conversationMessages(messages).map(serializeMessage);
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
  context: Context,
  parts: string[],
): string[] | undefined {
  if (!state.opencodeSessionId) return undefined;
  if (state.modelId !== modelId) return undefined;
  if ((state.toolsKey ?? "") !== serializeTools(resolveTurnTools(context))) {
    return undefined;
  }
  if ((state.systemPrompt ?? "") !== resolveTurnSystemPrompt(context)) {
    return undefined;
  }
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
    "This message continues your existing OpenCode session: the Pi system prompt,",
    "tool list, and earlier transcript are already in context. Do not ask for them again.",
    "If you need Pi to run a tool, your entire response must contain only one or more",
    "tool-call blocks separated by whitespace:",
    '<pi_tool_call>{"name":"tool_name","arguments":{}}</pi_tool_call>',
    "Use only exact tool names from the earlier tool list. Never quote markers, explain",
    "them, or wrap them in Markdown fences. A \"read\" tool in your own tool list belongs",
    "to OpenCode, not to Pi, and is disabled in this session - never call it.",
    "If you can answer without a tool, answer normally.",
    "",
    "# New transcript since your last response",
    "",
    deltaParts.join("\n\n---\n\n"),
    "",
    "Now produce the next assistant message for Pi.",
  ].join("\n");
}

const AGENT_BODY = `You are the OpenCode side of a Pi Coding Agent bridge. OpenCode tools are disabled. Reply in plain text, or emit <pi_tool_call>{"name":"...","arguments":{...}}</pi_tool_call> exactly when the prompt asks you to request a Pi tool.
`;

/**
 * Agent definition for OpenCode v1, which uses the legacy `permission` map
 * and the v1 action names (`bash`, `task`).
 *
 * `read` asks instead of denying for the same reason as in {@link AGENT_V2}:
 * the free-tier gateway refuses a request that declares no tools. Both
 * `opencode run` and the streaming server path reject the ask, so the read
 * never executes.
 */
const AGENT_V1 = `---
description: Pi bridge agent. OpenCode tools are denied; Pi tool calls are emitted as text markers.
mode: primary
permission:
  "*": deny
  read: ask
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
${AGENT_BODY}`;

/**
 * Agent definition for OpenCode v2, which replaced the `permission` map with
 * an ordered `permissions` rule list (`shell` replaces `bash`, `subagent`
 * replaces `task`).
 *
 * Every action is denied except one inert read rule. A denied tool is removed
 * from the request, and OpenCode's free-tier gateway rejects a request that
 * declares no tools at all ("OpenCode's free tier can only be used from
 * within OpenCode"), so a deny-all agent cannot call the free models. The
 * remaining read rule keeps exactly one harmless tool declared, so the
 * request still looks like a normal OpenCode request, and the read itself
 * still needs an approval that a non-interactive `opencode run` auto-rejects.
 * No OpenCode tool can execute, and the model only ever sees that one tool.
 */
const AGENT_V2 = `---
description: Pi bridge agent. OpenCode tools are denied; Pi tool calls are emitted as text markers.
mode: primary
permissions:
  - action: "*"
    resource: "*"
    effect: deny
  - action: read
    resource: "*"
    effect: ask
---
${AGENT_BODY}`;

/** The agent definition matching the installed OpenCode CLI dialect. */
export function agentDefinition(dialect: CliDialect): string {
  return dialect === "v2" ? AGENT_V2 : AGENT_V1;
}

// OpenCode v2.1.1 also refuses with "Permission denied: <rule>" (e.g. a read
// outside the project directory) and "No tool named ..." (a tool the agent
// does not declare). The first is anchored so an OS error such as
// "EACCES: permission denied, open ..." still counts as executed.
const OPENCODE_PERMISSION_REJECTION =
  /cannot ask the user for permission|request was rejected|rejected permission|user rejected|^permission denied: [\w.-]+$|^no tool named "[^"]*" is currently available/i;

/** Whether a native tool's error state is OpenCode refusing it before it ran. */
function isRefusedTool(toolState: { status?: string; error?: unknown } | undefined): boolean {
  if (toolState?.status !== "error") return false;
  const error = toolState.error as { message?: unknown } | string | undefined;
  const text = typeof error === "object" && error !== null ? error.message : error;
  return OPENCODE_PERMISSION_REJECTION.test(String(text ?? ""));
}

async function createTempAgentDir(dialect: CliDialect): Promise<string> {
  // realpath keeps PWD and the spawn cwd identical where tmpdir is a symlink
  // (macOS /var -> /private/var).
  const dir = await realpath(await mkdtemp(join(tmpdir(), "opencode-pi-")));
  const agentsDir = join(dir, ".opencode", "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(
    join(agentsDir, `${AGENT_ID}.md`),
    agentDefinition(dialect),
    "utf8",
  );
  if (dialect === "v1") {
    // OpenCode would spend a second request on the same model to title each
    // session. On the free tier that request shares, and hits, the rate limit.
    await writeFile(join(agentsDir, "title.md"), "---\ndisable: true\n---\n", "utf8");
  }
  return dir;
}

/** Unload a project directory from the shared server, then delete it. */
async function removeSessionDir(dir: string): Promise<void> {
  const server = runningOpenCodeServer();
  if (server) {
    await serverRequest(
      server,
      "POST",
      "/instance/dispose",
      dir,
      undefined,
      AbortSignal.timeout(SESSION_DELETE_TIMEOUT_MS),
    ).catch(() => undefined);
  }
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/** Everything one `opencode run` invocation produced. */
export type OpenCodeTurnState = {
  text: string;
  thinking: string;
  stderr: string;
  sessionId?: string;
  toolUse?: string;
  error?: string;
  finishReason: "stop" | "length";
  timedOut: boolean;
};

/** True when OpenCode could not resolve the bridge's agent. */
export function isAgentNotFoundError(stderr: string): boolean {
  return /agent not found/i.test(stderr);
}

/**
 * Run one `opencode run` invocation and collect its JSON event stream.
 *
 * The invocation is always bounded by `timeoutMs`, and the abort listener is
 * detached on every exit path — success, error, and timeout alike (#72).
 */
export async function runOpenCodeTurn(params: {
  args: string[];
  prompt: string;
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  model: Model<Api>;
  output: AssistantMessage;
}): Promise<{ code: number | null; state: OpenCodeTurnState }> {
  const { args, prompt, cwd, signal, timeoutMs, model, output } = params;
  const state: OpenCodeTurnState = {
    text: "",
    thinking: "",
    stderr: "",
    finishReason: "stop",
    timedOut: false,
  };

  const child = spawn(opencodeBin(), args, {
    stdio: ["pipe", "pipe", "pipe"],
    ...(cwd ? { cwd } : {}),
    env: {
      ...process.env,
      OPENCODE_DISABLE_UPDATE_CHECK: "1",
      // OpenCode resolves its working directory from PWD, and spawning with
      // `cwd` does not update PWD. Without this the CLI loads the project
      // config from the parent's directory, never registers the bridge
      // agent, and fails the turn with "Agent not found".
      ...(cwd ? { PWD: cwd } : {}),
    },
  });

  const abort = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    state.timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);

  let stdoutRemainder = "";
  child.stdin!.end(prompt);
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      state.stderr = (state.stderr + `\n${line}`).slice(-STDERR_LIMIT);
      return;
    }

    // Every JSON event carries the OpenCode session ID (#71).
    if (typeof event.sessionID === "string" && event.sessionID) {
      state.sessionId = event.sessionID;
    } else if (
      typeof event.part?.sessionID === "string" &&
      event.part.sessionID
    ) {
      state.sessionId = event.part.sessionID;
    }

    if (event.type === "text" && typeof event.part?.text === "string") {
      state.text += event.part.text;
      return;
    }

    if (event.type === "reasoning" && typeof event.part?.text === "string") {
      state.thinking += event.part.text;
      return;
    }

    if (event.type === "step_finish") {
      if (/length|max.?tokens/i.test(String(event.part?.reason ?? ""))) {
        state.finishReason = "length";
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
      // The agent denies OpenCode's own tools, so OpenCode refuses them
      // before they run. A refused tool changed nothing and the model can
      // carry on with a Pi marker; a tool that actually executed means
      // OpenCode did work Pi was supposed to do, and the turn fails.
      // `metadata.providerCall.executed` marks provider-executed calls and is
      // false for every tool OpenCode runs locally, so it says nothing about
      // refusal. Only OpenCode's permission-rejection error counts; a tool
      // that ran and failed (e.g. EACCES "permission denied") still executed.
      if (!isRefusedTool(event.part?.state)) {
        state.toolUse = event.part?.tool ? String(event.part.tool) : "unknown";
      }
      return;
    }

    if (event.type === "error") {
      const message =
        event.error?.data?.message ??
        event.error?.message ??
        event.part?.message;
      state.error =
        typeof message === "string" && message.trim()
          ? message.trim()
          : safeJson(event);
      state.stderr = (state.stderr + `\n${state.error}`).slice(-STDERR_LIMIT);
    }
  };

  child.stdout!.on("data", (chunk: string) => {
    stdoutRemainder += chunk;
    const lines = stdoutRemainder.split(/\r?\n/);
    stdoutRemainder = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  });
  child.stderr!.on("data", (chunk: string) => {
    state.stderr = (state.stderr + chunk).slice(-STDERR_LIMIT);
  });

  let code: number | null;
  try {
    code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
  } finally {
    signal?.removeEventListener("abort", abort);
    clearTimeout(timer);
  }
  if (stdoutRemainder.trim()) handleLine(stdoutRemainder);

  return { code, state };
}

/** Receives a server turn's text and reasoning deltas as they arrive. */
export type OpenCodeStreamSink = {
  text(partId: string, delta: string): void;
  thinking(partId: string, delta: string): void;
};

/**
 * Run one turn on the shared `opencode serve` (OpenCode v1) and pass text and
 * reasoning deltas to `sink` while the model writes them. `opencode run` only
 * prints a part once it is finished.
 *
 * The result has the same shape as {@link runOpenCodeTurn}: `code` is 0 once
 * the session goes idle and null when the turn was aborted or timed out.
 */
export async function runOpenCodeServerTurn(params: {
  server: OpenCodeServer;
  directory: string;
  /** Recorded session to continue; a new session is created otherwise. */
  sessionId?: string;
  body: unknown;
  signal?: AbortSignal;
  timeoutMs: number;
  model: Model<Api>;
  output: AssistantMessage;
  sink: OpenCodeStreamSink;
  onSessionId?: (sessionId: string) => void;
}): Promise<{ code: number | null; state: OpenCodeTurnState }> {
  const { server, directory, body, signal, timeoutMs, model, output, sink } = params;
  const state: OpenCodeTurnState = {
    text: "",
    thinking: "",
    stderr: "",
    finishReason: "stop",
    timedOut: false,
  };

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, timeoutMs);
  const request = (method: string, path: string, payload?: unknown) =>
    serverRequest(server, method, path, directory, payload, controller.signal);

  const partKinds = new Map<string, "text" | "thinking">();
  const partText = new Map<string, string>();
  const userMessages = new Set<string>();
  const append = (partId: string, delta: string) => {
    const kind = partKinds.get(partId);
    if (!kind || !delta) return;
    partText.set(partId, (partText.get(partId) ?? "") + delta);
    if (kind === "text") {
      state.text += delta;
      sink.text(partId, delta);
    } else {
      state.thinking += delta;
      sink.thinking(partId, delta);
    }
  };

  /** Handle one server event; returns true once the session is idle. */
  const handleEvent = async (event: ServerEvent): Promise<boolean> => {
    const props = event.properties ?? {};

    if (event.type === "message.updated") {
      const info = props.info;
      if (info?.sessionID === state.sessionId && info?.role === "user") {
        userMessages.add(info.id);
      }
      return false;
    }

    if (event.type === "message.part.delta") {
      if (props.sessionID === state.sessionId && props.field === "text" && typeof props.delta === "string") {
        append(props.partID, props.delta);
      }
      return false;
    }

    if (event.type === "message.part.updated") {
      const part = props.part;
      if (!part || part.sessionID !== state.sessionId || userMessages.has(part.messageID)) {
        return false;
      }
      // Only the model's own parts carry `time`; the prompt's text part
      // does not.
      if ((part.type === "text" || part.type === "reasoning") && part.time && !part.synthetic) {
        partKinds.set(part.id, part.type === "text" ? "text" : "thinking");
        // Older servers send the whole text so far instead of deltas, and a
        // finished part carries its full text: emit what is still missing.
        const seen = partText.get(part.id) ?? "";
        if (typeof part.text === "string" && part.text.startsWith(seen)) {
          append(part.id, part.text.slice(seen.length));
        }
        return false;
      }
      if (part.type === "step-finish") {
        if (/length|max.?tokens/i.test(String(part.reason ?? ""))) {
          state.finishReason = "length";
        }
        const tokens = part.tokens;
        if (!tokens) return false;
        output.usage.input = Number(tokens.input ?? 0);
        output.usage.output = Number(tokens.output ?? 0) + Number(tokens.reasoning ?? 0);
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
        return false;
      }
      if (part.type === "tool" && (part.state?.status === "completed" || part.state?.status === "error")) {
        // Same rule as `opencode run`: a refused OpenCode tool changed
        // nothing, a tool that executed fails the turn.
        if (!isRefusedTool(part.state)) state.toolUse = part.tool ? String(part.tool) : "unknown";
      }
      return false;
    }

    if (event.type === "permission.asked" && props.sessionID === state.sessionId) {
      // `opencode run` auto-rejects asks, so the server does too. Rejecting
      // one ask rejects every pending ask in the session, so a parallel
      // call's ask can already be gone (404) by its turn.
      await request("POST", `/permission/${props.id}/reply`, { reply: "reject" }).catch(
        (error: unknown) => {
          if (!/ failed with 404:/.test(String(error))) throw error;
        },
      );
      return false;
    }

    if (event.type === "session.error" && props.sessionID === state.sessionId) {
      const message = props.error?.data?.message ?? props.error?.message ?? props.error?.name;
      state.error =
        typeof message === "string" && message.trim() ? message.trim() : safeJson(props.error);
      state.stderr = (state.stderr + `\n${state.error}`).slice(-STDERR_LIMIT);
      return false;
    }

    return (
      props.sessionID === state.sessionId &&
      ((event.type === "session.status" && props.status?.type === "idle") ||
        event.type === "session.idle")
    );
  };

  let finished = false;
  try {
    // Subscribe first so no event published for the prompt is missed.
    const events = await subscribeEvents(server, directory, controller.signal);
    try {
      const sessionId = params.sessionId ?? (await request("POST", "/session", {}))?.id;
      if (typeof sessionId !== "string" || !sessionId) {
        throw new Error("OpenCode did not return a session ID");
      }
      state.sessionId = sessionId;
      params.onSessionId?.(sessionId);
      await request("POST", `/session/${sessionId}/prompt_async`, body);
      for await (const event of events) {
        if (await handleEvent(event)) {
          finished = true;
          break;
        }
      }
    } finally {
      await events.return(undefined).catch(() => undefined);
    }
    if (!finished) throw new Error("OpenCode event stream ended before the turn finished");
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    if (state.sessionId) {
      await serverRequest(
        server,
        "POST",
        `/session/${state.sessionId}/abort`,
        directory,
        undefined,
        AbortSignal.timeout(SESSION_DELETE_TIMEOUT_MS),
      ).catch(() => undefined);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    clearTimeout(timer);
  }

  return { code: finished ? 0 : null, state };
}

// Set once `opencode serve` failed to start for a binary, so later turns go
// straight to `opencode run` instead of waiting on the server again.
let serverUnavailableFor: string | undefined;

// In-session correction budget for a model that fires one of OpenCode's
// disabled native tools. OPENCODE_PI_TOOL_RESCUES=0 restores the old
// fail-fast behaviour.
function nativeToolRescues(): number {
  const raw = Number(process.env.OPENCODE_PI_TOOL_RESCUES ?? 2);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
}

/** Rebuild argv with `--session <id>` pointing at the captured OpenCode session. */
function withSessionId(args: string[], sessionId: string): string[] {
  const out = args.filter(
    (arg, index) => arg !== "--session" && args[index - 1] !== "--session",
  );
  out.push("--session", sessionId);
  return out;
}

/** Corrective follow-up sent inside the same OpenCode session. */
function buildNativeToolCorrection(tool: string): string {
  return [
    `You invoked OpenCode's native "${tool}" tool. OpenCode tools are disabled`,
    `in this session and nothing from that call reaches Pi.`,
    `If you need Pi to run a tool, your entire response must contain only one`,
    `or more tool-call blocks separated by whitespace:`,
    `<pi_tool_call>{"name":"tool_name","arguments":{}}</pi_tool_call>`,
    `Use only exact tool names from the earlier tool list. If you can answer`,
    `without a tool, answer normally.`,
  ].join("\n");
}

export function streamOpenCode(
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
    // Session ID of the OpenCode session this turn created, so a failed turn
    // can delete the record it left behind (#71).
    let capturedSessionId: string | undefined;
    // Per-Pi-session reuse key supplied by Pi core (stable for the life of
    // the Pi session). Without it, every turn runs an isolated fresh
    // session in its own temporary directory.
    const piSessionId =
      typeof options?.sessionId === "string" && options.sessionId
        ? options.sessionId
        : undefined;
    const piState = piSessionId ? getPiSessionState(piSessionId) : undefined;
    const transcriptParts = serializedTranscriptParts(context.messages);

    // Server turns stream as they arrive. Each OpenCode text or reasoning
    // part becomes one Pi content block, closed when the next one starts,
    // and text passes the marker filter first.
    let streamed = false;
    const filter = createMarkerStreamFilter();
    let open: { partId: string; index: number } | undefined;
    let visibleText = "";
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
    const appendBlock = (partId: string, kind: "text" | "thinking", delta: string) => {
      if (!delta) return;
      if (open?.partId !== partId || output.content[open.index]?.type !== kind) {
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
        stream.push({ type: "thinking_delta", contentIndex, delta, partial: output });
      }
    };
    const sink: OpenCodeStreamSink = {
      text: (partId, delta) => appendBlock(partId, "text", filter.push(delta)),
      thinking: (partId, delta) => appendBlock(partId, "thinking", delta),
    };

    try {
      stream.push({ type: "start", partial: output });
      if (options?.signal?.aborted) throw new Error("Request was aborted");

      // Continuation decision (#75, #76): reuse the recorded OpenCode
      // session only when the model, tools, system prompt, and transcript
      // prefix all still match. Any drift restarts fresh — and the stale
      // session record is deleted so it cannot leak.
      let delta = piState
        ? continuationDelta(piState, model.id, context, transcriptParts)
        : undefined;
      if (piState && piState.opencodeSessionId && delta === undefined) {
        dropOpencodeSession(piState);
      }
      const isContinuation = delta !== undefined;
      const prompt = isContinuation
        ? buildContinuationPrompt(delta)
        : buildPrompt(context);
      // Pi 1.x system messages are prompt scaffolding, not transcript
      // entries, so the delta is sliced from the conversation messages.
      const conversation = conversationMessages(context.messages);
      const sentMessages = isContinuation
        ? conversation.slice(transcriptParts.length - delta.length)
        : conversation;

      // The CLI dialect decides which agent definition is written, so it has
      // to be resolved before the project directory is created.
      const dialect = await cliDialect();
      const sessionDir = piState
        ? await ensurePiSessionDir(piState, dialect)
        : await createTempAgentDir(dialect).then((dir) => {
            tempDir = dir;
            return dir;
          });
      if (options?.signal?.aborted) throw new Error("Request was aborted");
      const images = imageContentsForModel(
        sentMessages,
        model.input.includes("image"),
      );
      const imagePaths = await writeImageFiles(images, sessionDir);
      if (options?.signal?.aborted) throw new Error("Request was aborted");
      const requestedReasoning = options?.reasoning as
        | ModelThinkingLevel
        | undefined;
      const variant = model.thinkingLevelMap?.[requestedReasoning ?? "off"];
      const args = dialect === "v2"
        ? [
            "run",
            "--standalone",
            "-m",
            typeof variant === "string" && variant.trim() && !model.id.includes("#")
              ? `${model.id}#${variant}`
              : model.id,
            "--agent",
            AGENT_ID,
            "--format",
            "json",
          ]
        : [
            "run",
            "--pure",
            "-m",
            model.id,
            "--agent",
            AGENT_ID,
            "--format",
            "json",
            "--dir",
            sessionDir,
          ];
      if (isContinuation && piState?.opencodeSessionId) {
        args.push("--session", piState.opencodeSessionId);
      }
      if (dialect === "v1") {
        args.push(
          ...reasoningCliArgs(requestedReasoning, model.thinkingLevelMap),
        );
      } else if (requestedReasoning && requestedReasoning !== "off") {
        args.push("--thinking");
      }
      for (const path of imagePaths) args.push("--file", path);

      // The timeout is unconditional: a turn is always bounded, even when
      // Pi supplies no timeoutMs (#73).
      const turnTimeoutMs = resolveTurnTimeoutMs(options?.timeoutMs);
      const bin = opencodeBin();
      let turn: { code: number | null; state: OpenCodeTurnState } | undefined;
      if (dialect === "v1" && streamingEnabled() && serverUnavailableFor !== bin) {
        // OpenCode v2's server speaks a different API, so only v1 streams.
        const serverVariant = requestedReasoning && requestedReasoning !== "off"
          ? model.thinkingLevelMap?.[requestedReasoning]
          : undefined;
        const slash = model.id.indexOf("/");
        const body = {
          agent: AGENT_ID,
          model: slash > 0
            ? { providerID: model.id.slice(0, slash), modelID: model.id.slice(slash + 1) }
            : { providerID: "opencode", modelID: model.id },
          ...(typeof serverVariant === "string" && serverVariant.trim()
            ? { variant: serverVariant }
            : {}),
          // The same file parts `opencode run --file` sends.
          parts: [
            ...imagePaths.map((path, index) => ({
              type: "file",
              mime: images[index]!.mimeType,
              filename: basename(path),
              url: pathToFileURL(path).href,
            })),
            { type: "text", text: prompt },
          ],
        };
        let serverStarted = false;
        try {
          turn = await withOpenCodeServer(
            bin,
            { ...process.env, OPENCODE_DISABLE_UPDATE_CHECK: "1" },
            (server) => {
              serverStarted = true;
              streamed = true;
              return runOpenCodeServerTurn({
                server,
                directory: sessionDir,
                sessionId: isContinuation ? piState?.opencodeSessionId : undefined,
                body,
                signal: options?.signal,
                timeoutMs: turnTimeoutMs,
                model,
                output,
                sink,
                onSessionId: (id) => {
                  capturedSessionId = id;
                },
              });
            },
          );
        } catch (error) {
          if (serverStarted || options?.signal?.aborted) throw error;
          // `opencode serve` did not start, so this CLI runs every turn
          // through `opencode run` instead.
          serverUnavailableFor = bin;
        }
      }
      turn ??= await runOpenCodeTurn({
        args,
        prompt,
        cwd: dialect === "v2" ? sessionDir : undefined,
        signal: options?.signal,
        timeoutMs: turnTimeoutMs,
        model,
        output,
      });
      // OpenCode's standalone server can resolve `--agent` before it has
      // loaded the project agent file, which fails the turn with "Agent not
      // found". A fresh process gets another chance at the same turn.
      if (
        !streamed &&
        turn.code !== 0 &&
        !turn.state.timedOut &&
        !options?.signal?.aborted &&
        isAgentNotFoundError(turn.state.stderr)
      ) {
        turn = await runOpenCodeTurn({
          args,
          prompt,
          cwd: dialect === "v2" ? sessionDir : undefined,
          signal: options?.signal,
          timeoutMs: turnTimeoutMs,
          model,
          output,
        });
      }
      // A model that fires a disabled OpenCode-native tool gets a bounded
      // corrective follow-up inside the same OpenCode session instead of a
      // dead turn; only an exhausted budget produces the error. The retry
      // always uses the CLI path — a short correction does not need the
      // streaming server.
      let turnResult = turn;
      let toolRescues = nativeToolRescues();
      for (;;) {
        const { code, state } = turnResult;
        capturedSessionId = state.sessionId ?? capturedSessionId;

        if (options?.signal?.aborted) {
          throw new Error("Request was aborted");
        }
        if (state.timedOut) {
          throw new Error(`opencode timed out after ${turnTimeoutMs}ms`);
        }
        if (code !== 0) {
          throw new Error(
            state.stderr.trim() || `opencode exited with code ${code}`,
          );
        }
        if (state.error) throw new Error(state.error);
        if (!state.toolUse) break;
        if (toolRescues-- <= 0 || !capturedSessionId) {
          throw new Error(
            `OpenCode attempted to use its disabled native tool (${JSON.stringify(state.toolUse)}). Retry the request; Pi tools must be requested with <pi_tool_call>{"name":"...","arguments":{}}</pi_tool_call> markers.`,
          );
        }
        turnResult = await runOpenCodeTurn({
          args: withSessionId(args, capturedSessionId),
          prompt: buildNativeToolCorrection(state.toolUse),
          cwd: dialect === "v2" ? sessionDir : undefined,
          signal: options?.signal,
          timeoutMs: turnTimeoutMs,
          model,
          output,
        });
      }
      const { state } = turnResult;

      const accumulatedText = state.text;
      const accumulatedThinking = state.thinking;
      const stderr = state.stderr;
      const finishReason = state.finishReason;

      const allowedToolNames = new Set(
        resolveTurnTools(context).map((tool) => tool.name),
      );
      const toolCallResult = parseToolCallResponse(
        accumulatedText,
        allowedToolNames,
      );
      if (!toolCallResult.ok) {
        throw new Error(
          toolCallRejectionMessage(toolCallResult, allowedToolNames),
        );
      }
      const toolCalls = toolCallResult.calls;
      // Unrecoverable marker text is stripped so it never leaks into the
      // visible chat response; remaining prose still displays normally.
      let displayText = toolCallResult.cleanedText ?? accumulatedText;
      if (streamed) {
        // Release the text the filter still holds, then the streamed text
        // is what Pi shows.
        appendBlock(
          open?.partId ?? "final",
          "text",
          filter.finish(toolCalls.length > 0 ? "" : displayText),
        );
        displayText = visibleText;
      }
      if (toolCalls.length === 0 && displayText.trim()) {
        // Check if the model tried to use XML-style tool-use instead of
        // <pi_tool_call> markers — a common mistake with Claude-based models.
        const xmlTool = detectXmlToolUse(displayText);
        if (xmlTool) {
          throw new Error(
            `OpenCode attempted to use its disabled native tool (${JSON.stringify(xmlTool)}). This bridge only accepts <pi_tool_call>{"name":"...","arguments":{}}</pi_tool_call> markers. Do not use XML-style tool-use syntax.`,
          );
        }
      }
      if (
        toolCalls.length === 0 &&
        !displayText.trim() &&
        !accumulatedThinking.trim()
      ) {
        const stderrMsg = stderr.trim();
        if (stderrMsg) {
          throw new Error(
            `OpenCode returned stderr: ${stderrMsg}`,
          );
        }
        // The model may have emitted text events with empty strings, or
        // may have produced reasoning-only output that was not captured
        // as assistant text. Provide a clearer diagnostic.
        const rawTextPreview = accumulatedText
          ? `raw text length=${accumulatedText.length} (trimmed to "${accumulatedText.slice(0, 80).replace(/\n/g, " ")}")`
          : "no text events received";
        const rawThinkingPreview = accumulatedThinking
          ? `thinking length=${accumulatedThinking.length}`
          : "no thinking output";
        throw new Error(
          `OpenCode returned empty assistant response (${rawTextPreview}; ${rawThinkingPreview}). This can happen with some free models when the prompt is too long, the model times out, or the model is overloaded. Retry the request or select another OpenCode model.`,
        );
      }
      // OpenCode v2.1 sometimes exits without its step_finish usage event.
      // A continuation only sent the delta, so estimate from the full
      // context the session holds, not the delta, or the context meter
      // collapses.
      setEstimatedUsage(
        model,
        output,
        isContinuation ? buildPrompt(context) : prompt,
        accumulatedText + accumulatedThinking,
      );
      // The turn succeeded: record the session for reuse, or delete the
      // one-shot session record so it cannot accumulate (#71, #75).
      if (piState) {
        piState.opencodeSessionId =
          capturedSessionId ?? piState.opencodeSessionId;
        piState.modelId = model.id;
        piState.toolsKey = serializeTools(resolveTurnTools(context));
        piState.systemPrompt = resolveTurnSystemPrompt(context);
        piState.sentParts = transcriptParts;
      } else {
        deleteOpenCodeSession(capturedSessionId);
      }

      // Streamed text and thinking are already in the message.
      if (streamed) closeOpen();
      else if (accumulatedThinking) {
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
      if (displayText && !streamed) {
        const contentIndex = output.content.length;
        output.content.push({ type: "text", text: displayText });
        stream.push({ type: "text_start", contentIndex, partial: output });
        stream.push({
          type: "text_delta",
          contentIndex,
          delta: displayText,
          partial: output,
        });
        stream.push({
          type: "text_end",
          contentIndex,
          content: displayText,
          partial: output,
        });
      }
      stream.push({ type: "done", reason: finishReason, message: output });
      stream.end();
    } catch (error) {
      closeOpen();
      // Any error, timeout, or abort drops the session ID so the next turn
      // starts fresh with the full transcript; the failed session record is
      // deleted best-effort and never fails the turn (#71, #75).
      deleteOpenCodeSession(capturedSessionId);
      if (piState) dropOpencodeSession(piState);
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage =
        error instanceof Error ? error.message : String(error);
      // Ensure output.content has text so downstream tools (model-debugger,
      // Pi agent) see real content instead of flagging a "silent failure."
      if (output.content.length === 0) {
        output.content.push({ type: "text", text: `Error: ${output.errorMessage}` });
      }
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    } finally {
      // Only one-shot turns own their directory. Per-Pi-session directories
      // persist for reuse and are removed at session teardown (#74).
      if (tempDir) await removeSessionDir(tempDir);
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
    streamingEnabled()
      ? "Streaming: OpenCode v1 replies stream through opencode serve; v2 replies arrive when each part finishes."
      : "Streaming: off (OPENCODE_PI_STREAM); replies arrive when each part finishes.",
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
  // Pi invalidates a session's ctx right after session_shutdown, so a
  // background check that settles later must not notify on it.
  let sessionGeneration = 0;
  pi.on("session_shutdown", () => {
    sessionGeneration++;
    void cleanupPiSessionState();
  });

  pi.on("session_start", (_event: any, ctx: any) => {
    const generation = ++sessionGeneration;
    void startupCheck.then((cliStatus) => {
      if (generation === sessionGeneration) notifyStartup(ctx, cliStatus);
    });
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
      // Pi's TUI replaces one info notification with the next, so each
      // subcommand sends its lines as a single multi-line notification.
      if (sub === "status") {
        ctx.ui.notify(statusLines().join("\n"), "info");
        return;
      }
      if (sub === "models") {
        ctx.ui.notify(
          [
            ...registeredModels.map((model) => `${PROVIDER_ID}/${model.id}`),
            `Override with OPENCODE_PI_MODELS="opencode/model-a,opencode/model-b"`,
          ].join("\n"),
          "info",
        );
        return;
      }
      if (sub === "test") {
        ctx.ui.notify(
          [
            `Run: pi -p --provider ${PROVIDER_ID} --model ${registeredModels[0]?.id ?? DEFAULT_FREE_MODELS[0]} "Reply with exactly OK"`,
            `OpenCode check: ${opencodeBin()} run -m ${registeredModels[0]?.id ?? DEFAULT_FREE_MODELS[0]} --format json "Reply OK"`,
          ].join("\n"),
          "info",
        );
        return;
      }
      if (sub === "update") {
        const refreshed = await refreshModels(pi);
        ctx.ui.notify([refreshed, ...statusLines()].join("\n"), "info");
        return;
      }
      if (sub === "help") {
        ctx.ui.notify(
          [
            "Usage: /opencode-pi [status|models|test|update|help]",
            "Set OPENCODE_PI_BIN to override the opencode executable.",
            "Set OPENCODE_PI_MODELS to register a custom comma-separated model list.",
            "Set OPENCODE_PI_STREAM=0 to run OpenCode v1 turns through opencode run instead of streaming them.",
          ].join("\n"),
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
