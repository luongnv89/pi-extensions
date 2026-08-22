export type CacheWarmAction = "on" | "off" | "status" | "metrics" | "toggle" | "unknown";

/** Parse `/cache-warm` args. Empty input toggles. */
export function parseCacheWarmArgs(args: string): CacheWarmAction {
	const token = args.trim().split(/\s+/).filter(Boolean)[0]?.toLowerCase() ?? "";
	switch (token) {
		case "":
			return "toggle";
		case "on":
		case "enable":
			return "on";
		case "off":
		case "disable":
			return "off";
		case "status":
			return "status";
		case "metrics":
			return "metrics";
		default:
			return "unknown";
	}
}
