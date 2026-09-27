import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir as mkdirAsync, rmdir as rmdirAsync } from "node:fs/promises";
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

export function preferencesLockPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, `.${PREFERENCES_FILE_NAME}.lock`);
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
export async function savePreferences(config: CacheWarmPreferencesPatch, agentDir: string = getAgentDir()): Promise<boolean> {
	return withPreferencesLock(agentDir, () => writePreferences(config, agentDir));
}

/** Merge one deliberate edit with stored settings without persisting enabled state or flags. */
export async function savePreferencesPatch(patch: CacheWarmPreferencesPatch, agentDir: string = getAgentDir()): Promise<boolean> {
	return withPreferencesLock(agentDir, () => writePreferences({ ...loadPreferences(agentDir), ...patch }, agentDir));
}

function writePreferences(config: CacheWarmPreferencesPatch, agentDir: string): boolean {
	const targetPath = preferencesPath(agentDir);
	const temporaryPath = join(agentDir, `.${PREFERENCES_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
	let fileDescriptor: number | undefined;
	try {
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

const LOCK_TIMEOUT_MS = 1_000;
const LOCK_RETRY_DELAY_MS = 10;
const LOCK_RETRY_JITTER_MS = 10;

async function withPreferencesLock(agentDir: string, operation: () => boolean): Promise<boolean> {
	const lockPath = preferencesLockPath(agentDir);
	let acquired = false;
	let result = false;
	try {
		await mkdirAsync(agentDir, { recursive: true, mode: 0o700 });
		const deadline = Date.now() + LOCK_TIMEOUT_MS;
		while (!acquired) {
			try {
				await mkdirAsync(lockPath, { mode: 0o700 });
				acquired = true;
			} catch (error) {
				if (!isAlreadyExistsError(error)) return false;
				const remainingMs = deadline - Date.now();
				if (remainingMs <= 0) return false;
				const delayMs = LOCK_RETRY_DELAY_MS + Math.floor(Math.random() * (LOCK_RETRY_JITTER_MS + 1));
				await delay(Math.min(delayMs, remainingMs));
			}
		}
		result = operation();
	} catch {
		result = false;
	} finally {
		if (acquired) {
			try {
				await rmdirAsync(lockPath);
			} catch {
				result = false;
			}
		}
	}
	return result;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlreadyExistsError(error: unknown): boolean {
	return isRecord(error) && error.code === "EEXIST";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidActiveMs(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
