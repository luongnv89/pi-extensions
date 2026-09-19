/**
 * Menu construction for the interactive `/fusion` configuration panel.
 *
 * Pi's dialog API takes and returns plain strings, so every row is built as a
 * `{ key, label }` pair and mapped back by label. Keeping that here makes the
 * labels testable without a terminal, the same way `indicator.ts` is.
 */

import { formatModelSpec, type FusionConfig, type FusionStats, type ModelSpec, toolsForMode } from "./config.js";
import { formatUsd } from "./metrics.js";

export type MenuRow<TKey extends string = string> = { key: TKey; label: string };

export type MenuKey =
	| "sidekick"
	| "upgrade"
	| "frontier"
	| "tools"
	| "thinking"
	| "max-delegations"
	| "routing"
	| "enabled"
	| "restart"
	| "reset"
	| "close";

export type ModelLike = {
	provider?: unknown;
	id?: unknown;
	cost?: { input?: unknown; output?: unknown };
};

export const MANUAL_ENTRY_LABEL = "Type a model id manually…";
export const CLEAR_LABEL = "Clear (none)";

/** Two columns, padded, so values line up under each other in the selector. */
export function buildMenuRows(config: FusionConfig, stats: FusionStats): MenuRow<MenuKey>[] {
	const entries: Array<[MenuKey, string, string]> = [
		["sidekick", "Sidekick model", formatModelSpec(config.sidekick)],
		["upgrade", "Stronger sidekick", formatModelSpec(config.sidekickUpgrade)],
		["frontier", "Frontier (escalation)", formatModelSpec(config.frontier)],
		["tools", "Sidekick tools", `${config.toolMode} (${toolsForMode(config.toolMode).join(", ")})`],
		["thinking", "Sidekick thinking", config.thinkingLevel],
		["max-delegations", "Max delegations", `${stats.delegations}/${config.maxDelegations} used`],
		["routing", "Compaction routing", config.routing ? "on" : "off"],
		["enabled", "pi-fusion", config.enabled ? "enabled" : "disabled"],
	];
	const width = Math.max(...entries.map(([, label]) => label.length));
	const rows: MenuRow<MenuKey>[] = entries.map(([key, label, value]) => ({
		key,
		label: `${label.padEnd(width)}  ${value}`,
	}));
	rows.push({ key: "restart", label: "Restart sidekick context" });
	rows.push({ key: "reset", label: "Reset counters and context" });
	rows.push({ key: "close", label: "Close" });
	return rows;
}

export function buildProviderRows(models: ModelLike[]): MenuRow[] {
	const counts = new Map<string, number>();
	for (const model of models) {
		if (typeof model.provider !== "string" || !model.provider) continue;
		counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([provider, count]) => ({ key: provider, label: `${provider} (${count})` }));
}

export type ModelOrder = "cheapest" | "priciest";

/**
 * Sidekick candidates are listed cheapest first and frontier candidates priciest
 * first, because that is the question being asked in each case. Prices are shown
 * so the choice is not made blind.
 */
export function buildModelRows(models: ModelLike[], provider: string, order: ModelOrder): MenuRow[] {
	const rows = models
		.filter((model) => model.provider === provider && typeof model.id === "string" && model.id)
		.map((model) => ({ spec: { provider, modelId: model.id as string }, price: inputPrice(model), model }))
		.sort((a, b) => {
			const left = a.price ?? Number.POSITIVE_INFINITY;
			const right = b.price ?? Number.POSITIVE_INFINITY;
			if (left === right) return a.spec.modelId.localeCompare(b.spec.modelId);
			return order === "cheapest" ? left - right : right - left;
		});
	return rows.map((row) => ({ key: `${row.spec.provider}/${row.spec.modelId}`, label: `${row.spec.modelId}${formatPrice(row.model)}` }));
}

export function formatPrice(model: ModelLike): string {
	const input = numeric(model.cost?.input);
	const output = numeric(model.cost?.output);
	if (input === undefined || output === undefined) return "";
	if (input === 0 && output === 0) return "  free";
	return `  ${formatUsd(input)}/${formatUsd(output)} per Mtok`;
}

/** Maps a chosen label back to its row; selectors hand back the label only. */
export function rowForLabel<TKey extends string>(rows: MenuRow<TKey>[], label: string | undefined): MenuRow<TKey> | undefined {
	if (label === undefined) return undefined;
	return rows.find((row) => row.label === label);
}

export function summariseSelection(slot: string, spec: ModelSpec | undefined): string {
	return spec ? `${slot} set to ${formatModelSpec(spec)}` : `${slot} cleared`;
}

function inputPrice(model: ModelLike): number | undefined {
	return numeric(model.cost?.input);
}

function numeric(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
