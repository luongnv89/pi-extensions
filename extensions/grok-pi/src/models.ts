export const PI_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];
export type ThinkingLevelMap = Partial<Record<PiThinkingLevel, string | null>>;

export type GrokReasoningEffort = {
	id?: string;
	value?: string;
	label?: string;
	description?: string;
	default?: boolean;
};

export type GrokModelInfo = {
	model: string;
	name?: string;
	context_window?: number;
	max_completion_tokens?: number | null;
	api_backend?: string;
	supports_reasoning_effort?: boolean;
	reasoning_effort?: string;
	reasoning_efforts?: GrokReasoningEffort[];
};

export type GrokModelsCache = {
	models?: Record<
		string,
		{
			info?: GrokModelInfo;
		}
	>;
};

const FALLBACK_REASONING_MAP: ThinkingLevelMap = {
	off: null,
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null,
};

export function defaultModelCatalog(): GrokModelInfo[] {
	return [
		{
			model: "grok-4.6",
			name: "Grok 4.6",
			context_window: 500_000,
			max_completion_tokens: null,
			api_backend: "responses",
			supports_reasoning_effort: true,
			reasoning_effort: "high",
			reasoning_efforts: [
				{ id: "xhigh", value: "xhigh" },
				{ id: "high", value: "high" },
				{ id: "medium", value: "medium" },
				{ id: "low", value: "low" },
			],
		},
		{
			model: "grok-4.5",
			name: "Grok 4.5",
			context_window: 500_000,
			max_completion_tokens: null,
			api_backend: "responses",
			supports_reasoning_effort: true,
			reasoning_effort: "high",
			reasoning_efforts: [
				{ id: "high", value: "high" },
				{ id: "medium", value: "medium" },
				{ id: "low", value: "low" },
			],
		},
		{
			model: "grok-composer-2.5-fast",
			name: "Composer 2.5",
			context_window: 200_000,
			max_completion_tokens: 30_000,
			api_backend: "responses",
		},
		{
			model: "grok-build",
			name: "Grok Build",
			context_window: 512_000,
			max_completion_tokens: 64_000,
			api_backend: "responses",
		},
	];
}

export function modelsFromCache(cache: GrokModelsCache | null | undefined): GrokModelInfo[] {
	if (!cache?.models) return defaultModelCatalog();
	const out: GrokModelInfo[] = [];
	for (const entry of Object.values(cache.models)) {
		const info = entry?.info;
		if (!info?.model) continue;
		out.push(info);
	}
	return out.length > 0 ? out : defaultModelCatalog();
}

export function modelSupportsReasoning(info: GrokModelInfo): boolean {
	if (info.supports_reasoning_effort === true) return true;
	return Array.isArray(info.reasoning_efforts) && info.reasoning_efforts.length > 0;
}

export function normalizeEffortToPiLevel(raw: string | undefined | null): PiThinkingLevel | undefined {
	if (!raw) return undefined;
	const value = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
	if (value === "off" || value === "none" || value === "disabled") return "off";
	if (value === "min" || value === "minimal") return "minimal";
	if (value === "low") return "low";
	if (value === "med" || value === "medium") return "medium";
	if (value === "high") return "high";
	if (value === "xhigh" || value === "extra_high" || value === "extra_high_effort") return "xhigh";
	if (value === "max" || value === "maximum") return "max";
	return undefined;
}

export function thinkingLevelMapFor(info: GrokModelInfo): ThinkingLevelMap | undefined {
	if (!modelSupportsReasoning(info)) return undefined;

	const advertised = new Map<PiThinkingLevel, string>();
	for (const effort of info.reasoning_efforts ?? []) {
		const rawValue = effort.value ?? effort.id;
		const level =
			normalizeEffortToPiLevel(rawValue) ?? normalizeEffortToPiLevel(effort.id);
		if (!level || !rawValue) continue;
		advertised.set(level, rawValue);
	}

	if (advertised.size === 0) return { ...FALLBACK_REASONING_MAP };

	const map: ThinkingLevelMap = {};
	for (const level of PI_THINKING_LEVELS) {
		map[level] = advertised.get(level) ?? null;
	}
	return map;
}

export function supportedThinkingLevels(info: GrokModelInfo): PiThinkingLevel[] {
	const map = thinkingLevelMapFor(info);
	if (!map) return [];
	return PI_THINKING_LEVELS.filter((level) => map[level] != null);
}

export function maxTokensFor(info: GrokModelInfo): number {
	if (typeof info.max_completion_tokens === "number" && info.max_completion_tokens > 0) {
		return info.max_completion_tokens;
	}
	if (typeof info.context_window === "number" && info.context_window > 0) {
		return info.context_window;
	}
	if (info.model.includes("composer")) return 30_000;
	if (info.model.includes("build")) return 64_000;
	return 16_384;
}

export function inputFor(info: GrokModelInfo): ("text" | "image")[] {
	const id = info.model.toLowerCase();
	if (id.includes("build") || id.includes("grok-4") || id.includes("vision")) {
		return ["text", "image"];
	}
	return ["text"];
}

export function buildProviderModels(infos: GrokModelInfo[]) {
	return infos.map((info) => {
		const reasoning = modelSupportsReasoning(info);
		const thinkingLevelMap = thinkingLevelMapFor(info);
		return {
			id: info.model,
			name: info.name ? `${info.name} (Grok CLI)` : `${info.model} (Grok CLI)`,
			reasoning,
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			input: inputFor(info),
			contextWindow: info.context_window ?? 128_000,
			maxTokens: maxTokensFor(info),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			headers: {
				"x-grok-model-override": info.model,
			},
			compat: {
				sendSessionIdHeader: false,
				supportsLongCacheRetention: false,
			},
		};
	});
}
