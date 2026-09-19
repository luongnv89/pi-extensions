import { calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";
import { emptyTokens, type FusionStats, type TokenTotals } from "./config.js";

/** Per-delegation usage, derived by diffing the sidekick session's cumulative stats. */
export function diffTokens(after: Partial<TokenTotals>, before: Partial<TokenTotals>): TokenTotals {
	const delta = emptyTokens();
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
		delta[key] = Math.max(0, num(after[key]) - num(before[key]));
	}
	return delta;
}

export function addTokens(a: TokenTotals, b: TokenTotals): TokenTotals {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		total: a.total + b.total,
	};
}

/**
 * What the same tokens would have cost on the main model.
 *
 * An estimate, not a measurement: the main agent would not have spent an
 * identical token mix on the same work. It is the only counterfactual available
 * without running every task twice.
 */
export function counterfactualCost(model: unknown, tokens: TokenTotals): number | undefined {
	if (!isPriceableModel(model)) return undefined;
	try {
		const usage = {
			input: tokens.input,
			output: tokens.output,
			cacheRead: tokens.cacheRead,
			cacheWrite: tokens.cacheWrite,
			totalTokens: tokens.total,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		} as unknown as Usage;
		const cost = calculateCost(model as Model<never>, usage);
		return Number.isFinite(cost?.total) && cost.total >= 0 ? cost.total : undefined;
	} catch {
		return undefined;
	}
}

export type SavingsSummary = {
	actual: number;
	counterfactual: number;
	saved: number;
	percent: number | undefined;
};

export function savingsSummary(stats: FusionStats): SavingsSummary {
	const actual = stats.sidekickCost;
	const counterfactual = stats.counterfactualCost;
	const saved = counterfactual - actual;
	const percent = counterfactual > 0 ? (saved / counterfactual) * 100 : undefined;
	return { actual, counterfactual, saved, percent };
}

export function formatUsd(value: number): string {
	if (!Number.isFinite(value)) return "$0.00";
	const abs = Math.abs(value);
	if (abs > 0 && abs < 0.01) return `${value < 0 ? "-" : ""}$${abs.toFixed(4)}`;
	return `${value < 0 ? "-" : ""}$${abs.toFixed(2)}`;
}

export function formatTokens(value: number): string {
	if (!Number.isFinite(value) || value < 0) return "0";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return `${Math.round(value)}`;
}

export function formatSavings(stats: FusionStats): string {
	const summary = savingsSummary(stats);
	if (summary.counterfactual <= 0) return `sidekick spend ${formatUsd(summary.actual)}`;
	const percent = summary.percent === undefined ? "" : ` (${summary.percent.toFixed(0)}%)`;
	return `sidekick ${formatUsd(summary.actual)} vs ${formatUsd(summary.counterfactual)} on main — est. saved ${formatUsd(summary.saved)}${percent}`;
}

function isPriceableModel(model: unknown): boolean {
	if (!model || typeof model !== "object") return false;
	const cost = (model as { cost?: Record<string, unknown> }).cost;
	if (!cost || typeof cost !== "object") return false;
	return (["input", "output", "cacheRead", "cacheWrite"] as const).every(
		(key) => typeof cost[key] === "number" && Number.isFinite(cost[key] as number) && (cost[key] as number) >= 0,
	);
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
