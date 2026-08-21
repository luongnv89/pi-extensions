import { join } from "node:path";

export const PROVIDER_ID = "hermes";
export const API_ID = "hermes-runner";
export const DEFAULT_CONTEXT_WINDOW = 131_072;
export const DEFAULT_MAX_TOKENS = 8_192;

export interface HermesModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  reasoning?: boolean;
  image?: boolean;
}

// Default Hermes models — users can override with HERMES_PI_MODELS.
// Keep in sync with the free tier on the Nous Portal (hermes).
export const BUNDLED_MODELS: HermesModelInfo[] = [
  {
    id: "upstage/solar-pro4:free",
    name: "Solar Pro 4",
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "meituan/longcat-2.0:free",
    name: "LongCat 2.0",
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "tencent/hy3:free",
    name: "Hunyuan 3",
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "poolside/laguna-s-2.1:free",
    name: "Laguna S 2.1",
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "stepfun/step-3.7-flash:free",
    name: "Step 3.7 Flash",
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "poolside/laguna-xs-2.1:free",
    name: "Laguna XS 2.1",
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
];

export function hermesBin(): string {
  return process.env.HERMES_PI_BIN?.trim() || "hermes";
}

export function hermesProvider(): string {
  return process.env.HERMES_PI_PROVIDER?.trim() || "nous";
}

export function configuredModels(): string[] | undefined {
  const raw = process.env.HERMES_PI_MODELS?.trim();
  if (!raw) return undefined;
  return raw
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function modelDisplayName(model: string): string {
  return `Hermes ${model}`;
}

export function fallbackModel(id: string): HermesModelInfo {
  return {
    id,
    name: modelDisplayName(id),
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

export function resolveModelInfos(ids: string[]): HermesModelInfo[] {
  return ids.map((id) => {
    const existing = BUNDLED_MODELS.find((m) => m.id === id);
    return existing ? { ...existing } : fallbackModel(id);
  });
}

/** Read free model ids from the hermes CLI provider cache (~/.hermes). */
export async function discoverCachedFreeModels(
  home: string,
  readFile: (path: string) => Promise<string>,
): Promise<string[]> {
  const cachePath = join(home, ".hermes", "provider_models_cache.json");
  const parsed = JSON.parse(await readFile(cachePath)) as {
    nous?: { models?: unknown };
  };
  const models = parsed?.nous?.models;
  if (!Array.isArray(models)) return [];
  return models.filter(
    (m): m is string => typeof m === "string" && m.endsWith(":free"),
  );
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Extract clean text from hermes --cli output.
 *
 * Raw output looks like:
 *   Query: ...
 *   Initializing agent...
 *   ┌─ Reasoning ───┐
 *   <reasoning text>
 *   └───────┘
 *   ╭─ ⚕ Hermes ───╮
 *   <answer>
 *   ╰───────╯
 *   Resume this session with: ...
 *   Session: ... Duration: ... Messages: ...
 */
export function cleanHermesOutput(raw: string): string {
  let content = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Remove ANSI escape codes
  content = content.replace(/\x1b\[[0-9;]*m/g, "");

  // Drop the reasoning box entirely
  content = content.replace(
    /┌[^\n]*Reasoning[^\n]*┐\n[\s\S]*?(?:\n└[^\n]*┘|\n?$)/g,
    "",
  );

  // Prefer the answer box (header contains the hermes badge)
  const answerBox = content.match(/╭[^\n]*Hermes[^\n]*╮\n([\s\S]*?)\n╰[^\n]*╯/);
  if (answerBox) {
    content = answerBox[1];
  } else {
    // No complete answer box yet (streaming or unexpected format):
    // strip known decoration lines instead.
    content = content.replace(/^Query:[^\n]*\n?/gm, "");
    content = content.replace(/Initializing agent\.\.\.\n(?:─+\n)?/g, "");
    content = content.replace(
      /Resume this session with:\n\s*hermes[^\n]*(\n\s*hermes[^\n]*)*/g,
      "",
    );
    content = content.replace(
      /\n?Session:[^\n]*\nTitle:[^\n]*\nDuration:[^\n]*\nMessages:[^\n]*/g,
      "",
    );
  }

  // Strip any leftover box-drawing characters
  content = content.replace(/[│┌┐└┘─╭╮╰╯]/g, "");

  return content.trim();
}
