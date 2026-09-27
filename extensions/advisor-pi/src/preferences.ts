import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir as mkdirAsync, rmdir as rmdirAsync } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const PREFERENCES_FILE_NAME = "advisor-pi.json";
export const PREFERENCES_VERSION = 1;

export type AdvisorPreferencesPatch = {
	enabled?: boolean;
	provider?: string;
	modelId?: string;
	thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	maxUses?: number;
	cacheRetention?: "none" | "short" | "long";
	maxTranscriptChars?: number;
};

export type AdvisorPreferences = AdvisorPreferencesPatch & { version: typeof PREFERENCES_VERSION };

export function preferencesPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, PREFERENCES_FILE_NAME);
}

export function preferencesLockPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, `.${PREFERENCES_FILE_NAME}.lock`);
}

/** Read and independently validate the durable advisor settings. */
export function loadPreferences(agentDir: string = getAgentDir()): AdvisorPreferencesPatch {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(preferencesPath(agentDir), "utf8"));
	} catch {
		return {};
	}
	if (!isRecord(parsed)) return {};
	if (parsed.version !== undefined && parsed.version !== PREFERENCES_VERSION) return {};

	return validatedPatch(parsed);
}

/** Atomically replace the private preferences file with mode 0600 contents. */
export async function savePreferences(config: AdvisorPreferencesPatch, agentDir: string = getAgentDir()): Promise<boolean> {
	return withPreferencesLock(agentDir, () => writePreferences(config, agentDir));
}

/** Merge and persist one deliberate user edit under the cross-process lock. */
export async function savePreferencesPatch(patch: AdvisorPreferencesPatch, agentDir: string = getAgentDir()): Promise<boolean> {
	return withPreferencesLock(agentDir, () => writePreferences({ ...loadPreferences(agentDir), ...patch }, agentDir));
}

function writePreferences(config: AdvisorPreferencesPatch, agentDir: string): boolean {
	const targetPath = preferencesPath(agentDir);
	const temporaryPath = join(agentDir, `.${PREFERENCES_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
	let fileDescriptor: number | undefined;
	try {
		fileDescriptor = openSync(temporaryPath, "wx", 0o600);
		const preferences = { version: PREFERENCES_VERSION, ...validatedPatch(config) };
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

export type AdvisorPreferencesConfig = {
	enabled: boolean;
	provider: string;
	modelId: string;
	thinkingLevel: NonNullable<AdvisorPreferencesPatch["thinkingLevel"]>;
	maxUses: number;
	cacheRetention: NonNullable<AdvisorPreferencesPatch["cacheRetention"]>;
	maxTranscriptChars: number;
};

function validatedPatch(input: unknown): AdvisorPreferencesPatch {
	const patch: AdvisorPreferencesPatch = {};
	if (!isRecord(input)) return patch;
	if (typeof input.enabled === "boolean") patch.enabled = input.enabled;
	if (typeof input.provider === "string" && input.provider.trim() && typeof input.modelId === "string" && input.modelId.trim()) {
		patch.provider = input.provider.trim();
		patch.modelId = input.modelId.trim();
	}
	const thinkingLevel = parseThinkingLevel(input.thinkingLevel);
	if (thinkingLevel) patch.thinkingLevel = thinkingLevel;
	const cacheRetention = parseCacheRetention(input.cacheRetention);
	if (cacheRetention) patch.cacheRetention = cacheRetention;
	if (isPositiveSafeInteger(input.maxUses)) patch.maxUses = input.maxUses;
	if (isPositiveSafeInteger(input.maxTranscriptChars)) patch.maxTranscriptChars = input.maxTranscriptChars;
	return patch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseCacheRetention(value: unknown): AdvisorPreferencesPatch["cacheRetention"] {
	if (value === "none" || value === "short" || value === "long") return value;
	return undefined;
}

function parseThinkingLevel(value: unknown): AdvisorPreferencesPatch["thinkingLevel"] {
	if (value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") {
		return value;
	}
	return undefined;
}
