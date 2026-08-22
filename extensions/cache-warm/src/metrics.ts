export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ModelRates {
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

export interface Metrics {
	warmAttempts: number;
	warmRefreshes: number;
	likelyAvoidedMisses: number;
	warmSpendUsd: number;
	grossDiscountUsd: number;
	pricingKnown: boolean;
}

export function createMetrics(): Metrics {
	return {
		warmAttempts: 0,
		warmRefreshes: 0,
		likelyAvoidedMisses: 0,
		warmSpendUsd: 0,
		grossDiscountUsd: 0,
		pricingKnown: true,
	};
}

export function normalizeUsage(usage?: Partial<TokenUsage> | null): TokenUsage {
	return {
		input: numberOrZero(usage?.input),
		output: numberOrZero(usage?.output),
		cacheRead: numberOrZero(usage?.cacheRead),
		cacheWrite: numberOrZero(usage?.cacheWrite),
	};
}

export function hasCacheActivity(usage: TokenUsage): boolean {
	return usage.cacheRead > 0 || usage.cacheWrite > 0;
}

export function hasValidRates(model: unknown): model is ModelRates {
	if (!model || typeof model !== "object") return false;
	const cost = (model as { cost?: unknown }).cost;
	if (!cost || typeof cost !== "object") return false;
	const rates = cost as Record<string, unknown>;
	return (["input", "output", "cacheRead", "cacheWrite"] as const).every((key) => isNonNegativeFinite(rates[key]));
}

/** Per-million token rates (same formula as Pi's calculateCost). */
export function calculateCostFromModelRates(model: ModelRates, usage: TokenUsage): number {
	const { input, output, cacheRead, cacheWrite } = model.cost;
	return (
		(input / 1_000_000) * usage.input +
		(output / 1_000_000) * usage.output +
		(cacheRead / 1_000_000) * usage.cacheRead +
		(cacheWrite / 1_000_000) * usage.cacheWrite
	);
}

/** USD cost of a turn from model rates, or null when rates are missing/invalid. */
export function estimateTurnUsd(model: unknown, usage: Partial<TokenUsage> | TokenUsage): number | null {
	if (!hasValidRates(model)) return null;
	return calculateCostFromModelRates(model, normalizeUsage(usage));
}

/**
 * Gross cache discount vs paying full input price for cacheRead tokens.
 * null when rates are missing/invalid.
 */
export function estimateGrossDiscountUsd(model: unknown, cacheRead: number): number | null {
	if (!hasValidRates(model)) return null;
	const tokens = numberOrZero(cacheRead);
	return (tokens / 1_000_000) * (model.cost.input - model.cost.cacheRead);
}

export function netUsdSaved(metrics: Metrics): number | null {
	if (!metrics.pricingKnown) return null;
	return metrics.grossDiscountUsd - metrics.warmSpendUsd;
}

export function formatUsd(amount: number | null): string {
	if (amount === null || !Number.isFinite(amount)) return "N/A";
	const sign = amount < 0 ? "-" : "";
	const abs = Math.abs(amount);
	if (abs === 0) return "$0.00";
	if (abs < 0.01) return `${sign}$${abs.toFixed(4)}`;
	if (abs < 1) return `${sign}$${abs.toFixed(3)}`;
	return `${sign}$${abs.toFixed(2)}`;
}

export function formatMetrics(metrics: Metrics): string {
	return [
		`attempts: ${metrics.warmAttempts}`,
		`refreshes: ${metrics.warmRefreshes}`,
		`likely avoided misses: ${metrics.likelyAvoidedMisses}`,
		`estimated net USD saved: ${formatUsd(netUsdSaved(metrics))}`,
	].join("\n");
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isNonNegativeFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
