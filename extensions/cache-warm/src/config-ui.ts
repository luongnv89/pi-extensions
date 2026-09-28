import { formatDurationMs } from "./command.js";
import type { WarmState } from "./warm.js";

export type CacheWarmMenuKey = "enabled" | "duration" | "rate" | "status" | "metrics" | "close";

export type CacheWarmMenuRow = {
	key: CacheWarmMenuKey;
	label: string;
};

/** Build the labels for the bare `/cache-warm` TUI panel. */
export function formatRateCap(state: Pick<WarmState, "rateLimitEnabled" | "maxPerHour">): string {
	if (!state.rateLimitEnabled) return "off (no hourly cap)";
	return state.maxPerHour === 0 ? "unlimited (no hourly cap)" : `on (${state.maxPerHour}/hour)`;
}

export function buildMenuRows(state: Pick<WarmState, "enabled" | "activeMs" | "rateLimitEnabled" | "maxPerHour">): CacheWarmMenuRow[] {
	return [
		{
			key: "enabled",
			label: state.enabled
				? "Disable cache-warm (currently on)"
				: "Enable cache-warm (billable; currently off)",
		},
		{ key: "duration", label: `Idle auto-stop: ${formatDurationMs(state.activeMs)}` },
		{ key: "rate", label: `Hourly rate limit: ${formatRateCap(state)}` },
		{ key: "status", label: "Show status" },
		{ key: "metrics", label: "Show metrics" },
		{ key: "close", label: "Close" },
	];
}

/** Maps a selected label back to its menu row; Escape yields no row. */
export function rowForLabel(
	rows: CacheWarmMenuRow[],
	label: string | undefined,
): CacheWarmMenuRow | undefined {
	if (label === undefined) return undefined;
	return rows.find((row) => row.label === label);
}

/** Select values shared by the duration setting in the panel. */
export const DURATION_OPTIONS = Object.freeze(["30m", "1h", "2h", "forever"]);
export const RATE_OPTIONS = Object.freeze(["on", "off"]);
