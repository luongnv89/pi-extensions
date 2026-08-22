import { calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";

export type TokenUsage = Usage;
export type MissBillingMode = "input" | "cacheWrite" | "cacheWrite1h";

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

export function normalizeUsage(usage?: Partial<Usage> | null): Usage {
	const input = tokenCount(usage?.input);
	const output = tokenCount(usage?.output);
	const cacheRead = tokenCount(usage?.cacheRead);
	const cacheWrite = tokenCount(usage?.cacheWrite);
	const cacheWrite1h = optionalTokenCount(usage?.cacheWrite1h);
	const reasoning = optionalTokenCount(usage?.reasoning);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
		...(reasoning === undefined ? {} : { reasoning }),
		totalTokens: tokenCount(usage?.totalTokens) || input + output + cacheRead + cacheWrite,
		cost: {
			input: money(usage?.cost?.input),
			output: money(usage?.cost?.output),
			cacheRead: money(usage?.cost?.cacheRead),
			cacheWrite: money(usage?.cost?.cacheWrite),
			total: money(usage?.cost?.total),
		},
	};
}

export function cloneUsage(usage: Partial<Usage> | Usage): Usage {
	return normalizeUsage(usage);
}

export function hasCacheActivity(usage: Usage): boolean {
	return usage.cacheRead > 0 || usage.cacheWrite > 0 || (usage.cacheWrite1h ?? 0) > 0;
}

export function inferMissBillingMode(model: unknown, usage?: Partial<Usage>): MissBillingMode | null {
	const cacheWrite = usage?.cacheWrite ?? 0;
	const cacheWrite1h = usage?.cacheWrite1h ?? 0;
	if (cacheWrite1h > cacheWrite) return null;
	if (cacheWrite1h > 0) return "cacheWrite1h";
	if (!model || typeof model !== "object") return null;
	const candidate = model as {
		api?: unknown;
		provider?: unknown;
		compat?: { cacheControlFormat?: unknown };
	};
	if (
		(candidate.api === "anthropic-messages" && candidate.provider === "anthropic") ||
		candidate.compat?.cacheControlFormat === "anthropic"
	) {
		return "cacheWrite";
	}
	if (
		((candidate.api === "openai-completions" || candidate.api === "openai-responses") &&
			candidate.provider === "openai") ||
		(candidate.api === "azure-openai-responses" && candidate.provider === "azure-openai") ||
		(candidate.api === "openai-codex-responses" &&
			(candidate.provider === "openai" || candidate.provider === "openai-codex"))
	) {
		return "input";
	}
	return null;
}

/** Actual reported cost when valid, otherwise Pi-native pricing of the full usage. */
export function estimateTurnUsd(model: unknown, usage: Partial<Usage> | Usage): number | null {
	if (!isUsageCoherent(usage)) return null;
	const normalized = normalizeUsage(usage);
	if (hasValidReportedCost(usage.cost)) return usage.cost.total;
	return calculateNativeTotal(model, normalized);
}

/** Actual-vs-counterfactual cost delta for cache-read tokens. */
export function estimateGrossBenefitUsd(
	model: unknown,
	actualUsage: Partial<Usage> | Usage,
	mode: MissBillingMode | null,
): number | null {
	if (mode === null || !isUsageCoherent(actualUsage)) return null;
	const actual = normalizeUsage(actualUsage);
	if (actual.cacheRead <= 0) return null;
	const miss = cloneUsage(actual);
	const attributable = miss.cacheRead;
	miss.cacheRead = 0;
	if (mode === "input") {
		miss.input += attributable;
	} else if (mode === "cacheWrite") {
		miss.cacheWrite += attributable;
	} else {
		miss.cacheWrite += attributable;
		miss.cacheWrite1h = (miss.cacheWrite1h ?? 0) + attributable;
	}
	const actualTotal = calculateNativeTotal(model, actual);
	const missTotal = calculateNativeTotal(model, miss);
	if (actualTotal === null || missTotal === null) return null;
	const gross = missTotal - actualTotal;
	return Number.isFinite(gross) && gross >= 0 ? gross : null;
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

function calculateNativeTotal(model: unknown, usage: Usage): number | null {
	if ((usage.cacheWrite1h ?? 0) > usage.cacheWrite) return null;
	if (!isPriceableModel(model)) return null;
	try {
		const total = calculateCost(model, usage).total;
		return isNonNegativeFinite(total) ? total : null;
	} catch {
		return null;
	}
}

function hasValidReportedCost(cost: Usage["cost"] | undefined): cost is Usage["cost"] {
	if (!cost) return false;
	if (![cost.input, cost.output, cost.cacheRead, cost.cacheWrite, cost.total].every(isNonNegativeFinite)) {
		return false;
	}
	const componentTotal = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
	return Math.abs(componentTotal - cost.total) <= Math.max(1e-12, Math.abs(cost.total) * 1e-9);
}

function isUsageCoherent(usage: Partial<Usage>): boolean {
	for (const value of [
		usage.input,
		usage.output,
		usage.cacheRead,
		usage.cacheWrite,
		usage.cacheWrite1h,
		usage.reasoning,
		usage.totalTokens,
	]) {
		if (value !== undefined && !isNonNegativeFinite(value)) return false;
	}
	return (usage.cacheWrite1h ?? 0) <= (usage.cacheWrite ?? 0);
}

function isPriceableModel(model: unknown): model is Model<any> {
	if (!model || typeof model !== "object") return false;
	const candidate = model as { cost?: Record<string, unknown> };
	return (
		candidate.cost !== undefined &&
		["input", "output", "cacheRead", "cacheWrite"].every((key) =>
			isNonNegativeFinite(candidate.cost?.[key]),
		)
	);
}

function tokenCount(value: unknown): number {
	return isNonNegativeFinite(value) ? value : 0;
}

function optionalTokenCount(value: unknown): number | undefined {
	return value === undefined ? undefined : tokenCount(value);
}

function money(value: unknown): number {
	return isNonNegativeFinite(value) ? value : 0;
}

function isNonNegativeFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
