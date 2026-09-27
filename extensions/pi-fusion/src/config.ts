/** Levels Pi accepts for the sidekick agent. Wider than pi-ai's ThinkingLevel, which has no "off". */
export type SidekickThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Built-in tools the sidekick agent may use, by mode. */
export const READONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
export const CODING_TOOLS = ["read", "grep", "find", "ls", "edit", "write", "bash"] as const;

export type SidekickToolMode = "readonly" | "coding";

export type ModelSpec = { provider: string; modelId: string };

/** Deliberate user settings that may cross fresh Pi runtimes. */
export type FusionConfigPatch = {
	enabled?: boolean;
	sidekick?: ModelSpec;
	sidekickUpgrade?: ModelSpec | null;
	frontier?: ModelSpec | null;
	thinkingLevel?: SidekickThinkingLevel;
	toolMode?: SidekickToolMode;
	maxDelegations?: number;
	routing?: boolean;
};

export type FusionConfig = {
	enabled: boolean;
	/** Cheap agent that executes delegated work. */
	sidekick: ModelSpec;
	/** Optional stronger sidekick, used before escalating the main agent. */
	sidekickUpgrade?: ModelSpec;
	/** Optional main-agent escalation target for compaction-boundary routing. */
	frontier?: ModelSpec;
	thinkingLevel: SidekickThinkingLevel;
	toolMode: SidekickToolMode;
	maxDelegations: number;
	timeoutMs: number;
	maxTaskChars: number;
	/** Compaction-boundary model routing. Off unless the user opts in. */
	routing: boolean;
};

export type TokenTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
};

export type FusionStats = {
	delegations: number;
	failures: number;
	consecutiveFailures: number;
	cleanDelegations: number;
	tokens: TokenTotals;
	sidekickCost: number;
	counterfactualCost: number;
	sidekickUpgraded: boolean;
	mainEscalated: boolean;
};

export type FusionStateEntry = {
	version: 1;
	config: FusionConfig;
	stats: FusionStats;
	updatedAt: string;
};

export const DEFAULT_SIDEKICK_MODEL = "openai-codex/gpt-5.6-luna";
export const FALLBACK_SIDEKICK_MODELS = [
	"openai-codex/gpt-5.6-luna",
	"openrouter/anthropic/claude-haiku-4.5",
	"openai-codex/gpt-5.4-mini",
	"groq/llama-3.1-8b-instant",
];
const DEFAULT_THINKING_LEVEL: SidekickThinkingLevel = "max";
const DEFAULT_MAX_DELEGATIONS = 25;
const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_MAX_TASK_CHARS = 8_000;

export type ModelRegistryLike = {
	find: (provider: string, modelId: string) => unknown;
	getAvailable?: () => Array<{ provider?: unknown; id?: unknown }>;
};

export function defaultConfig(): FusionConfig {
	return {
		enabled: true,
		sidekick: parseModelSpec(DEFAULT_SIDEKICK_MODEL) ?? { provider: "openai-codex", modelId: "gpt-5.6-luna" },
		thinkingLevel: DEFAULT_THINKING_LEVEL,
		// The sidekick edits and runs commands unattended by default: its nested
		// session has no approval prompts. `/fusion tools readonly` takes that away.
		toolMode: "coding",
		maxDelegations: DEFAULT_MAX_DELEGATIONS,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		maxTaskChars: DEFAULT_MAX_TASK_CHARS,
		routing: false,
	};
}

export function emptyTokens(): TokenTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

export function defaultStats(): FusionStats {
	return {
		delegations: 0,
		failures: 0,
		consecutiveFailures: 0,
		cleanDelegations: 0,
		tokens: emptyTokens(),
		sidekickCost: 0,
		counterfactualCost: 0,
		sidekickUpgraded: false,
		mainEscalated: false,
	};
}

export function toolsForMode(mode: SidekickToolMode): string[] {
	return mode === "coding" ? [...CODING_TOOLS] : [...READONLY_TOOLS];
}

export function formatModelSpec(spec: ModelSpec | undefined): string {
	return spec ? `${spec.provider}/${spec.modelId}` : "unset";
}

export function parseModelSpec(value: string): ModelSpec | undefined {
	const trimmed = value.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	const provider = trimmed.slice(0, slash).trim();
	const modelId = trimmed.slice(slash + 1).trim();
	if (!provider || !modelId) return undefined;
	return { provider, modelId };
}

export function parseThinkingLevel(value: unknown): SidekickThinkingLevel | undefined {
	if (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh" ||
		value === "max"
	) {
		return value;
	}
	return undefined;
}

export function parseToolMode(value: unknown): SidekickToolMode | undefined {
	if (value === "readonly" || value === "coding") return value;
	return undefined;
}

export function parsePositiveInt(value: string): number | undefined {
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) return undefined;
	const parsed = Number(trimmed);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
	return parsed;
}

export function parseBoolean(value: string): boolean | undefined {
	const normalized = value.trim().toLowerCase();
	if (normalized === "on" || normalized === "true" || normalized === "enable" || normalized === "enabled") return true;
	if (normalized === "off" || normalized === "false" || normalized === "disable" || normalized === "disabled") return false;
	return undefined;
}

export function modelResolves(registry: ModelRegistryLike | undefined, spec: ModelSpec | undefined): boolean {
	if (!registry || !spec) return false;
	try {
		const found = registry.find(spec.provider, spec.modelId);
		return found !== undefined && found !== null;
	} catch {
		return false;
	}
}

/** First candidate the registry can resolve, else the first available model, else undefined. */
export function resolveSidekickModel(
	registry: ModelRegistryLike | undefined,
	candidates: string[] = FALLBACK_SIDEKICK_MODELS,
): ModelSpec | undefined {
	if (!registry) return undefined;
	for (const candidate of candidates) {
		const spec = parseModelSpec(candidate);
		if (spec && modelResolves(registry, spec)) return spec;
	}
	try {
		const available = registry.getAvailable?.();
		const first = Array.isArray(available) ? available[0] : undefined;
		if (first && typeof first.provider === "string" && typeof first.id === "string" && first.provider && first.id) {
			return { provider: first.provider, modelId: first.id };
		}
	} catch {
		// Registry listing failures leave the caller on its current config.
	}
	return undefined;
}

function optionalSpec(input: unknown, fallback: ModelSpec | undefined): ModelSpec | undefined {
	if (input === null) return undefined;
	if (input === undefined) return fallback;
	const candidate = input as Partial<ModelSpec>;
	if (
		typeof candidate.provider === "string" &&
		candidate.provider.trim() &&
		typeof candidate.modelId === "string" &&
		candidate.modelId.trim()
	) {
		return { provider: candidate.provider.trim(), modelId: candidate.modelId.trim() };
	}
	return fallback;
}

export function normalizeConfig(input: Partial<FusionConfig> | FusionConfigPatch, fallback: FusionConfig): FusionConfig {
	const runtimeInput = input as Partial<FusionConfig>;
	return {
		enabled: typeof input.enabled === "boolean" ? input.enabled : fallback.enabled,
		sidekick: optionalSpec(input.sidekick, fallback.sidekick) ?? fallback.sidekick,
		sidekickUpgrade: optionalSpec(input.sidekickUpgrade, fallback.sidekickUpgrade),
		frontier: optionalSpec(input.frontier, fallback.frontier),
		thinkingLevel: parseThinkingLevel(input.thinkingLevel) ?? fallback.thinkingLevel,
		toolMode: parseToolMode(input.toolMode) ?? fallback.toolMode,
		maxDelegations:
			typeof input.maxDelegations === "number" && Number.isSafeInteger(input.maxDelegations) && input.maxDelegations > 0
				? input.maxDelegations
				: fallback.maxDelegations,
		timeoutMs:
			typeof runtimeInput.timeoutMs === "number" && Number.isSafeInteger(runtimeInput.timeoutMs) && runtimeInput.timeoutMs > 0
				? runtimeInput.timeoutMs
				: fallback.timeoutMs,
		maxTaskChars:
			typeof runtimeInput.maxTaskChars === "number" && Number.isSafeInteger(runtimeInput.maxTaskChars) && runtimeInput.maxTaskChars > 0
				? runtimeInput.maxTaskChars
				: fallback.maxTaskChars,
		routing: typeof input.routing === "boolean" ? input.routing : fallback.routing,
	};
}

export function normalizeStats(input: Partial<FusionStats> | undefined, fallback: FusionStats): FusionStats {
	if (!input) return fallback;
	const tokens = input.tokens;
	return {
		delegations: nonNegative(input.delegations, fallback.delegations),
		failures: nonNegative(input.failures, fallback.failures),
		consecutiveFailures: nonNegative(input.consecutiveFailures, fallback.consecutiveFailures),
		cleanDelegations: nonNegative(input.cleanDelegations, fallback.cleanDelegations),
		tokens: {
			input: nonNegative(tokens?.input, fallback.tokens.input),
			output: nonNegative(tokens?.output, fallback.tokens.output),
			cacheRead: nonNegative(tokens?.cacheRead, fallback.tokens.cacheRead),
			cacheWrite: nonNegative(tokens?.cacheWrite, fallback.tokens.cacheWrite),
			total: nonNegative(tokens?.total, fallback.tokens.total),
		},
		sidekickCost: nonNegative(input.sidekickCost, fallback.sidekickCost),
		counterfactualCost: nonNegative(input.counterfactualCost, fallback.counterfactualCost),
		sidekickUpgraded: typeof input.sidekickUpgraded === "boolean" ? input.sidekickUpgraded : fallback.sidekickUpgraded,
		mainEscalated: typeof input.mainEscalated === "boolean" ? input.mainEscalated : fallback.mainEscalated,
	};
}

function nonNegative(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
