import { randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const PREFERENCES_VERSION = 1;

/** Fixed allow-listed names within the extension-specific preferences directory. */
export const PREFERENCE_FILE_NAMES = Object.freeze({
	activeMs: "activeMs.json",
	rateLimitEnabled: "rateLimitEnabled.json",
});

export type CacheWarmPreferencesPatch = {
	activeMs?: number;
	rateLimitEnabled?: boolean;
};

export type CacheWarmPreferences = CacheWarmPreferencesPatch & { version: typeof PREFERENCES_VERSION };

/** Return the directory containing cache-warm's per-setting files. */
export function preferencesPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "cache-warm-preferences");
}

/** Read only the durable duration and rate settings; enabled is intentionally absent. */
export function loadPreferences(agentDir: string = getAgentDir()): CacheWarmPreferencesPatch {
	const patch: CacheWarmPreferencesPatch = {};
	const activeMs = readPreference(agentDir, PREFERENCE_FILE_NAMES.activeMs)?.activeMs;
	if (isValidActiveMs(activeMs)) patch.activeMs = activeMs;
	const rateLimitEnabled = readPreference(agentDir, PREFERENCE_FILE_NAMES.rateLimitEnabled)?.rateLimitEnabled;
	if (typeof rateLimitEnabled === "boolean") patch.rateLimitEnabled = rateLimitEnabled;
	return patch;
}

/** Validate and persist supplied logical settings without any aggregate snapshot. */
export async function savePreferences(config: CacheWarmPreferencesPatch, agentDir: string = getAgentDir()): Promise<boolean> {
	return saveValidatedPreferences(config, agentDir);
}

/** Validate and persist one or more deliberate logical setting edits. */
export async function savePreferencesPatch(patch: CacheWarmPreferencesPatch, agentDir: string = getAgentDir()): Promise<boolean> {
	return saveValidatedPreferences(patch, agentDir);
}

type PreferenceWrite = { fileName: string; payload: Record<string, unknown> };

async function saveValidatedPreferences(input: unknown, agentDir: string): Promise<boolean> {
	const writes = prepareWrites(input);
	if (!writes) return false;
	try {
		mkdirSync(preferencesPath(agentDir), { recursive: true, mode: 0o700 });
	} catch {
		return false;
	}
	for (const write of writes) {
		if (!writePreference(agentDir, write)) return false;
	}
	return true;
}

function prepareWrites(input: unknown): PreferenceWrite[] | undefined {
	if (!isRecord(input)) return undefined;
	if (input.version !== undefined && input.version !== PREFERENCES_VERSION) return undefined;

	const keys = Object.keys(input).filter((key) => key !== "version");
	if (keys.length === 0) return undefined;
	const writes: PreferenceWrite[] = [];
	for (const key of keys) {
		switch (key) {
			case "activeMs":
				if (!isValidActiveMs(input.activeMs)) return undefined;
				writes.push({ fileName: PREFERENCE_FILE_NAMES.activeMs, payload: { version: PREFERENCES_VERSION, activeMs: input.activeMs } });
				break;
			case "rateLimitEnabled":
				if (typeof input.rateLimitEnabled !== "boolean") return undefined;
				writes.push({
					fileName: PREFERENCE_FILE_NAMES.rateLimitEnabled,
					payload: { version: PREFERENCES_VERSION, rateLimitEnabled: input.rateLimitEnabled },
				});
				break;
			default:
				return undefined;
		}
	}
	return writes;
}

function readPreference(agentDir: string, fileName: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(preferencesPath(agentDir), fileName), "utf8"));
		if (!isRecord(parsed)) return undefined;
		if (parsed.version !== undefined && parsed.version !== PREFERENCES_VERSION) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

function writePreference(agentDir: string, write: PreferenceWrite): boolean {
	const directory = preferencesPath(agentDir);
	const temporaryPath = join(directory, `.${write.fileName}.${process.pid}.${randomUUID()}.tmp`);
	let fileDescriptor: number | undefined;
	try {
		fileDescriptor = openSync(temporaryPath, "wx", 0o600);
		writeFileSync(fileDescriptor, `${JSON.stringify(write.payload, null, 2)}\n`, "utf8");
		fsyncSync(fileDescriptor);
		closeSync(fileDescriptor);
		fileDescriptor = undefined;
		renameSync(temporaryPath, join(directory, write.fileName));
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidActiveMs(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
