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
	enabled: "enabled.json",
	model: "model.json",
	thinkingLevel: "thinkingLevel.json",
	maxUses: "maxUses.json",
	cacheRetention: "cacheRetention.json",
	maxTranscriptChars: "maxTranscriptChars.json",
});

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

/** Return the directory containing advisor-pi's per-setting files. */
export function preferencesPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "advisor-pi-preferences");
}

/** Read and independently validate the durable advisor settings. */
export function loadPreferences(agentDir: string = getAgentDir()): AdvisorPreferencesPatch {
	const patch: AdvisorPreferencesPatch = {};
	const enabled = readPreference(agentDir, PREFERENCE_FILE_NAMES.enabled);
	if (enabled && typeof enabled.enabled === "boolean") patch.enabled = enabled.enabled;

	const model = readPreference(agentDir, PREFERENCE_FILE_NAMES.model);
	if (model && typeof model.provider === "string" && model.provider.trim() && typeof model.modelId === "string" && model.modelId.trim()) {
		patch.provider = model.provider.trim();
		patch.modelId = model.modelId.trim();
	}

	const thinkingLevel = parseThinkingLevel(readPreference(agentDir, PREFERENCE_FILE_NAMES.thinkingLevel)?.thinkingLevel);
	if (thinkingLevel) patch.thinkingLevel = thinkingLevel;

	const maxUses = readPreference(agentDir, PREFERENCE_FILE_NAMES.maxUses)?.maxUses;
	if (isPositiveSafeInteger(maxUses)) patch.maxUses = maxUses;

	const cacheRetention = parseCacheRetention(readPreference(agentDir, PREFERENCE_FILE_NAMES.cacheRetention)?.cacheRetention);
	if (cacheRetention) patch.cacheRetention = cacheRetention;

	const maxTranscriptChars = readPreference(agentDir, PREFERENCE_FILE_NAMES.maxTranscriptChars)?.maxTranscriptChars;
	if (isPositiveSafeInteger(maxTranscriptChars)) patch.maxTranscriptChars = maxTranscriptChars;

	return patch;
}

/** Validate and persist supplied logical settings without any aggregate snapshot. */
export async function savePreferences(config: AdvisorPreferencesPatch, agentDir: string = getAgentDir()): Promise<boolean> {
	return saveValidatedPreferences(config, agentDir);
}

/** Validate and persist one or more deliberate logical setting edits. */
export async function savePreferencesPatch(patch: AdvisorPreferencesPatch, agentDir: string = getAgentDir()): Promise<boolean> {
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
	const hasProvider = keys.includes("provider");
	const hasModelId = keys.includes("modelId");
	if (hasProvider || hasModelId) {
		if (!hasProvider || !hasModelId || typeof input.provider !== "string" || !input.provider.trim() || typeof input.modelId !== "string" || !input.modelId.trim()) {
			return undefined;
		}
		writes.push({
			fileName: PREFERENCE_FILE_NAMES.model,
			payload: {
				version: PREFERENCES_VERSION,
				provider: input.provider.trim(),
				modelId: input.modelId.trim(),
			},
		});
	}

	for (const key of keys) {
		switch (key) {
			case "provider":
			case "modelId":
				break;
			case "enabled":
				if (typeof input.enabled !== "boolean") return undefined;
				writes.push({ fileName: PREFERENCE_FILE_NAMES.enabled, payload: { version: PREFERENCES_VERSION, enabled: input.enabled } });
				break;
			case "thinkingLevel": {
				const thinkingLevel = parseThinkingLevel(input.thinkingLevel);
				if (!thinkingLevel) return undefined;
				writes.push({ fileName: PREFERENCE_FILE_NAMES.thinkingLevel, payload: { version: PREFERENCES_VERSION, thinkingLevel } });
				break;
			}
			case "maxUses":
				if (!isPositiveSafeInteger(input.maxUses)) return undefined;
				writes.push({ fileName: PREFERENCE_FILE_NAMES.maxUses, payload: { version: PREFERENCES_VERSION, maxUses: input.maxUses } });
				break;
			case "cacheRetention": {
				const cacheRetention = parseCacheRetention(input.cacheRetention);
				if (!cacheRetention) return undefined;
				writes.push({ fileName: PREFERENCE_FILE_NAMES.cacheRetention, payload: { version: PREFERENCES_VERSION, cacheRetention } });
				break;
			}
			case "maxTranscriptChars":
				if (!isPositiveSafeInteger(input.maxTranscriptChars)) return undefined;
				writes.push({
					fileName: PREFERENCE_FILE_NAMES.maxTranscriptChars,
					payload: { version: PREFERENCES_VERSION, maxTranscriptChars: input.maxTranscriptChars },
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

export type AdvisorPreferencesConfig = {
	enabled: boolean;
	provider: string;
	modelId: string;
	thinkingLevel: NonNullable<AdvisorPreferencesPatch["thinkingLevel"]>;
	maxUses: number;
	cacheRetention: NonNullable<AdvisorPreferencesPatch["cacheRetention"]>;
	maxTranscriptChars: number;
};

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
