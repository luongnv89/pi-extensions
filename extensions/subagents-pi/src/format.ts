export type LifetimeUsage = { input: number; output: number; cacheWrite: number };

export function getLifetimeTotal(usage?: LifetimeUsage): number {
	if (!usage) return 0;
	return usage.input + usage.output + usage.cacheWrite;
}

export function formatCompactTokenCount(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return String(count);
}

export function formatContextLabel(
	totalTokens: number,
	contextPercent: number | null | undefined,
	compactionCount?: number,
): string {
	const base = formatCompactTokenCount(totalTokens);
	const parts: string[] = [];
	if (contextPercent != null && Number.isFinite(contextPercent)) {
		parts.push(`${Math.round(contextPercent)}%`);
	}
	if (compactionCount && compactionCount > 0) {
		parts.push(`⇊${compactionCount}`);
	}
	if (parts.length === 0) return base;
	return `${base} (${parts.join(" · ")})`;
}

export function computeOutputTps(outputTokens: number, durationMs: number): number | undefined {
	if (durationMs <= 0 || outputTokens <= 0) return undefined;
	return outputTokens / (durationMs / 1000);
}

export function formatTps(tps: number | undefined): string {
	if (tps === undefined || !Number.isFinite(tps) || tps <= 0) return "—";
	if (tps >= 100) return `${Math.round(tps)}`;
	if (tps >= 10) return tps.toFixed(1);
	return tps.toFixed(2);
}

export function formatThinkingLevel(level: string | undefined): string {
	if (!level) return "—";
	return level;
}

export function formatModelLabel(modelName: string | undefined, agentType: string): string {
	if (modelName && modelName.trim()) return modelName;
	return agentType;
}

export function formatDurationMs(durationMs: number): string {
	if (durationMs < 1000) return `${durationMs}ms`;
	const seconds = durationMs / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	const rem = Math.round(seconds % 60);
	return `${minutes}m${rem}s`;
}