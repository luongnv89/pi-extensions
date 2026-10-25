import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseDurationMs } from "./command.js";

/** Startup settings read from the user-authored `cache-warm.json` config file. */
export interface CacheWarmConfig {
	/** Start each session with keep-alive on. */
	enabled?: boolean;
	/** Idle auto-stop in milliseconds; `0` means forever. */
	activeMs?: number;
	/** Whether the hourly ping cap applies. */
	rateLimitEnabled?: boolean;
}

/** Path of the user-authored config file. */
export function configPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "cache-warm.json");
}

/**
 * Read `cache-warm.json`. Accepted keys: `enabled` (boolean), `duration`
 * (`"1h"`, `"30m"`, `"forever"`, or a number of minutes) and `rateLimit`
 * (boolean or `"on"`/`"off"`). Missing, malformed, or invalid values are
 * ignored independently.
 */
export function loadConfig(agentDir: string = getAgentDir()): CacheWarmConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(configPath(agentDir), "utf8"));
	} catch {
		return {};
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	const input = raw as Record<string, unknown>;
	const config: CacheWarmConfig = {};

	if (typeof input.enabled === "boolean") config.enabled = input.enabled;

	const duration = typeof input.duration === "number" ? String(input.duration) : input.duration;
	if (typeof duration === "string") {
		const activeMs = parseDurationMs(duration);
		if (activeMs !== undefined) config.activeMs = activeMs;
	}

	const rate = parseBoolish(input.rateLimit);
	if (rate !== undefined) config.rateLimitEnabled = rate;
	return config;
}

function parseBoolish(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	const token = value.trim().toLowerCase();
	if (token === "on" || token === "true") return true;
	if (token === "off" || token === "false") return false;
	return undefined;
}
