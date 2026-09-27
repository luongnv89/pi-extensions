import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const PREFERENCES_FILE_NAME = "cache-warm.json";
export const PREFERENCES_VERSION = 1;

export type CacheWarmPreferencesPatch = {
	activeMs?: number;
	rateLimitEnabled?: boolean;
};

export type CacheWarmPreferences = CacheWarmPreferencesPatch & { version: typeof PREFERENCES_VERSION };

export function preferencesPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, PREFERENCES_FILE_NAME);
}

/** Read only the durable duration and rate settings; enabled is intentionally absent. */
export function loadPreferences(agentDir: string = getAgentDir()): CacheWarmPreferencesPatch {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(preferencesPath(agentDir), "utf8"));
	} catch {
		return {};
	}
	if (!isRecord(parsed)) return {};
	if (parsed.version !== undefined && parsed.version !== PREFERENCES_VERSION) return {};

	const patch: CacheWarmPreferencesPatch = {};
	if (isValidActiveMs(parsed.activeMs)) patch.activeMs = parsed.activeMs;
	if (typeof parsed.rateLimitEnabled === "boolean") patch.rateLimitEnabled = parsed.rateLimitEnabled;
	return patch;
}

/** Atomically replace the private preferences file with mode-0600 contents. */
export function savePreferences(config: CacheWarmPreferencesPatch, agentDir: string = getAgentDir()): boolean {
	const targetPath = preferencesPath(agentDir);
	const temporaryPath = join(agentDir, `.${PREFERENCES_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
	let fileDescriptor: number | undefined;
	try {
		mkdirSync(agentDir, { recursive: true, mode: 0o700 });
		fileDescriptor = openSync(temporaryPath, "wx", 0o600);
		const preferences: CacheWarmPreferences = {
			version: PREFERENCES_VERSION,
			...(isValidActiveMs(config.activeMs) ? { activeMs: config.activeMs } : {}),
			...(typeof config.rateLimitEnabled === "boolean" ? { rateLimitEnabled: config.rateLimitEnabled } : {}),
		};
		writeFileSync(fileDescriptor, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
		fsyncSync(fileDescriptor);
		closeSync(fileDescriptor);
		fileDescriptor = undefined;
		renameSync(temporaryPath, targetPath);
		return true;
	} catch {
		return false;
	} finally {
		if (fileDescriptor !== undefined) {
			try {
				closeSync(fileDescriptor);
			} catch {
				// Best-effort cleanup after a failed write.
			}
		}
		try {
			unlinkSync(temporaryPath);
		} catch {
			// The rename succeeded, or the temporary file was never created.
		}
	}
}

/** Merge one deliberate edit with stored settings without persisting enabled state or flags. */
export function savePreferencesPatch(patch: CacheWarmPreferencesPatch, agentDir: string = getAgentDir()): boolean {
	return savePreferences({ ...loadPreferences(agentDir), ...patch }, agentDir);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidActiveMs(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
