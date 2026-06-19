import type { AppleFmConfig } from "./config.js";

export type AppleFmModelDef = {
	id: string;
	name: string;
	description: string;
};

export const STATIC_MODELS: AppleFmModelDef[] = [
	{
		id: "system",
		name: "Apple Foundation Model (on-device)",
		description: "On-device inference via Neural Engine. Best for privacy and zero token cost.",
	},
	{
		id: "pcc",
		name: "Apple Foundation Model (Private Cloud Compute)",
		description: "Apple-hosted PCC when available in your account/context.",
	},
];

function limitsForModel(id: string, cfg: AppleFmConfig): { contextWindow: number; maxTokens: number } {
	if (id === "system") {
		return {
			contextWindow: cfg.contextWindow,
			maxTokens: Math.min(cfg.maxTokens, cfg.contextWindow),
		};
	}
	// PCC (when launch-terminal works) — larger budget than on-device; still below Pi's 128k fiction.
	const pccCtx = Math.max(cfg.contextWindow, 32_768);
	return { contextWindow: pccCtx, maxTokens: Math.min(cfg.maxTokens, 8192) };
}

export function buildProviderModels(cfg: AppleFmConfig) {
	return STATIC_MODELS.map((m) => {
		const limits = limitsForModel(m.id, cfg);
		return {
		id: m.id,
		name: m.name,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		contextWindow: limits.contextWindow,
		maxTokens: limits.maxTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsStore: false,
			supportsUsageInStreaming: false,
			supportsStrictMode: false,
			maxTokensField: "max_tokens" as const,
		},
	};
	});
}