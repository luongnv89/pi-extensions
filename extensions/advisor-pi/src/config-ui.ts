import type { AdvisorConfig } from "./index.js";

/** Rows used by the interactive advisor-pi settings menu. */
export type MenuRow<TKey extends string = string> = { key: TKey; label: string };

export type MenuKey =
	| "enabled"
	| "model"
	| "thinking"
	| "max-uses"
	| "max-transcript-chars"
	| "cache"
	| "reset"
	| "close";

/** Build the top-level settings rows, including the current value for each setting. */
export function buildMenuRows(config: AdvisorConfig, useCount = 0): MenuRow<MenuKey>[] {
	const entries: Array<[MenuKey, string, string]> = [
		["enabled", "Advisor enabled", config.enabled ? "enabled" : "disabled"],
		["model", "Advisor model", "configured (use /advisor-pi status for ID)"],
		["thinking", "Advisor thinking", config.thinkingLevel],
		["max-uses", "Max advisor uses", String(config.maxUses)],
		["max-transcript-chars", "Max transcript chars", String(config.maxTranscriptChars)],
		["cache", "Cache retention", config.cacheRetention],
	];
	const width = Math.max(...entries.map(([, label]) => label.length));
	const rows = entries.map(([key, label, value]) => ({
		key,
		label: `${label.padEnd(width)}  ${value}`,
	}));
	rows.push({ key: "reset", label: `Reset use count  (${useCount} used)` });
	rows.push({ key: "close", label: "Close" });
	return rows;
}

/** Maps a selected label back to its row; cancelled dialogs return undefined. */
export function rowForLabel<TKey extends string>(rows: MenuRow<TKey>[], label: string | undefined): MenuRow<TKey> | undefined {
	if (label === undefined) return undefined;
	return rows.find((row) => row.label === label);
}
