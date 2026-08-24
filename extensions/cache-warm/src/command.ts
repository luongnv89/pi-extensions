export type CacheWarmAction =
	| "on"
	| "off"
	| "status"
	| "metrics"
	| "toggle"
	| "duration"
	| "rate"
	| "unknown";

export interface ParsedCacheWarmArgs {
	action: CacheWarmAction;
	/** Set when action is "duration" and a value was given. 0 means no idle auto-stop. */
	durationMs?: number;
	/** Set when action is "rate" and on/off was given. */
	rateEnabled?: boolean;
	error?: string;
}

const FOREVER_TOKENS = new Set(["forever", "unlimited", "infinite", "none"]);

/** Parse a duration such as `30m`, `1h`, `1h30m`, `90` (minutes), or `forever`. */
export function parseDurationMs(raw: string): number | undefined {
	const token = raw.trim().toLowerCase();
	if (!token) return undefined;
	if (FOREVER_TOKENS.has(token)) return 0;
	if (/^\d+$/.test(token)) {
		const minutes = Number(token);
		return minutes > 0 ? minutes * 60_000 : undefined;
	}
	const match = token.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/);
	if (!match || !(match[1] || match[2] || match[3])) return undefined;
	const ms =
		Number(match[1] ?? 0) * 3_600_000 + Number(match[2] ?? 0) * 60_000 + Number(match[3] ?? 0) * 1_000;
	return ms > 0 ? ms : undefined;
}

export function formatDurationMs(ms: number): string {
	if (ms === 0) return "forever";
	const totalSeconds = Math.round(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	let out = "";
	if (hours) out += `${hours}h`;
	if (minutes) out += `${minutes}m`;
	if (seconds || !out) out += `${seconds}s`;
	return out;
}

/** Parse `/cache-warm` args. Empty input toggles. */
export function parseCacheWarmArgs(args: string): ParsedCacheWarmArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const first = tokens[0]?.toLowerCase() ?? "";
	switch (first) {
		case "":
			return { action: "toggle" };
		case "on":
		case "enable":
			return { action: "on" };
		case "off":
		case "disable":
			return { action: "off" };
		case "status":
			return { action: "status" };
		case "metrics":
			return { action: "metrics" };
		case "duration":
		case "for": {
			if (tokens.length === 1) return { action: "duration" };
			const rest = tokens.slice(1).join(" ");
			const durationMs = parseDurationMs(rest);
			if (durationMs === undefined) {
				return {
					action: "unknown",
					error: `Invalid duration "${rest}". Try 30m, 1h, 2h, or forever.`,
				};
			}
			return { action: "duration", durationMs };
		}
		case "rate":
		case "limit": {
			if (tokens.length === 1) return { action: "rate" };
			const rest = tokens[1]?.toLowerCase() ?? "";
			if (rest === "on" || rest === "enable") return { action: "rate", rateEnabled: true };
			if (rest === "off" || rest === "disable") return { action: "rate", rateEnabled: false };
			return {
				action: "unknown",
				error: `Invalid rate setting "${tokens.slice(1).join(" ")}". Try on or off.`,
			};
		}
		default: {
			if (tokens.length === 1) {
				const durationMs = parseDurationMs(first);
				if (durationMs !== undefined) return { action: "duration", durationMs };
			}
			return {
				action: "unknown",
				error: "Usage: /cache-warm [on|off|status|metrics|duration [30m|1h|forever]|rate [on|off]]",
			};
		}
	}
}
