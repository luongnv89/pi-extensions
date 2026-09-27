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
import {
	defaultConfig,
	normalizeConfig,
	parseModelSpec,
	parseThinkingLevel,
	parseToolMode,
	type FusionConfig,
	type FusionConfigPatch,
	type ModelSpec,
} from "./config.js";

export const PREFERENCES_VERSION = 1;

/** Fixed allow-listed names within the extension-specific preferences directory. */
export const PREFERENCE_FILE_NAMES = Object.freeze({
	enabled: "enabled.json",
	sidekick: "sidekick.json",
	sidekickUpgrade: "sidekickUpgrade.json",
	frontier: "frontier.json",
	thinkingLevel: "thinkingLevel.json",
	toolMode: "toolMode.json",
	maxDelegations: "maxDelegations.json",
	routing: "routing.json",
});

/** Return the directory containing pi-fusion's per-setting files. */
export function preferencesPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "pi-fusion-preferences");
}

/**
 * Read durable settings independently. Missing, malformed, or stale files are
 * treated as no preferences; one invalid field does not discard valid fields.
 */
export function loadPreferences(agentDir: string = getAgentDir()): FusionConfigPatch {
	const patch: FusionConfigPatch = {};
	const enabled = readPreference(agentDir, PREFERENCE_FILE_NAMES.enabled);
	if (enabled && typeof enabled.enabled === "boolean") patch.enabled = enabled.enabled;

	const sidekick = readPreference(agentDir, PREFERENCE_FILE_NAMES.sidekick);
	if (sidekick && isModelSpec(sidekick.sidekick)) patch.sidekick = sidekick.sidekick;

	const sidekickUpgrade = readPreference(agentDir, PREFERENCE_FILE_NAMES.sidekickUpgrade);
	if (sidekickUpgrade && (sidekickUpgrade.sidekickUpgrade === null || isModelSpec(sidekickUpgrade.sidekickUpgrade))) {
		patch.sidekickUpgrade = sidekickUpgrade.sidekickUpgrade;
	}

	const frontier = readPreference(agentDir, PREFERENCE_FILE_NAMES.frontier);
	if (frontier && (frontier.frontier === null || isModelSpec(frontier.frontier))) patch.frontier = frontier.frontier;

	const thinkingLevel = parseThinkingLevel(readPreference(agentDir, PREFERENCE_FILE_NAMES.thinkingLevel)?.thinkingLevel);
	if (thinkingLevel) patch.thinkingLevel = thinkingLevel;

	const toolMode = parseToolMode(readPreference(agentDir, PREFERENCE_FILE_NAMES.toolMode)?.toolMode);
	if (toolMode) patch.toolMode = toolMode;

	const maxDelegations = readPreference(agentDir, PREFERENCE_FILE_NAMES.maxDelegations)?.maxDelegations;
	if (isPositiveSafeInteger(maxDelegations)) patch.maxDelegations = maxDelegations;

	const routing = readPreference(agentDir, PREFERENCE_FILE_NAMES.routing)?.routing;
	if (typeof routing === "boolean") patch.routing = routing;

	return patch;
}

/** Load preferences on top of unchanged defaults for a fresh runtime. */
export function loadConfig(agentDir: string = getAgentDir()): FusionConfig {
	return normalizeConfig(loadPreferences(agentDir), defaultConfig());
}

/** Validate and persist one or more deliberate logical setting edits. */
export async function savePreferencesPatch(patch: FusionConfigPatch, agentDir: string = getAgentDir()): Promise<boolean> {
	return saveValidatedPreferences(patch, agentDir);
}

/** Validate and persist supplied logical settings without any aggregate snapshot. */
export async function savePreferences(config: FusionConfigPatch, agentDir: string = getAgentDir()): Promise<boolean> {
	return saveValidatedPreferences(config, agentDir);
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
			case "enabled":
				if (typeof input.enabled !== "boolean") return undefined;
				writes.push({ fileName: PREFERENCE_FILE_NAMES.enabled, payload: { version: PREFERENCES_VERSION, enabled: input.enabled } });
				break;
			case "sidekick":
				if (!isModelSpec(input.sidekick)) return undefined;
				writes.push({ fileName: PREFERENCE_FILE_NAMES.sidekick, payload: { version: PREFERENCES_VERSION, sidekick: input.sidekick } });
				break;
			case "sidekickUpgrade":
				if (input.sidekickUpgrade !== null && !isModelSpec(input.sidekickUpgrade)) return undefined;
				writes.push({
					fileName: PREFERENCE_FILE_NAMES.sidekickUpgrade,
					payload: { version: PREFERENCES_VERSION, sidekickUpgrade: input.sidekickUpgrade },
				});
				break;
			case "frontier":
				if (input.frontier !== null && !isModelSpec(input.frontier)) return undefined;
				writes.push({ fileName: PREFERENCE_FILE_NAMES.frontier, payload: { version: PREFERENCES_VERSION, frontier: input.frontier } });
				break;
			case "thinkingLevel":
				if (!parseThinkingLevel(input.thinkingLevel)) return undefined;
				writes.push({ fileName: PREFERENCE_FILE_NAMES.thinkingLevel, payload: { version: PREFERENCES_VERSION, thinkingLevel: input.thinkingLevel } });
				break;
			case "toolMode":
				if (!parseToolMode(input.toolMode)) return undefined;
				writes.push({ fileName: PREFERENCE_FILE_NAMES.toolMode, payload: { version: PREFERENCES_VERSION, toolMode: input.toolMode } });
				break;
			case "maxDelegations":
				if (!isPositiveSafeInteger(input.maxDelegations)) return undefined;
				writes.push({ fileName: PREFERENCE_FILE_NAMES.maxDelegations, payload: { version: PREFERENCES_VERSION, maxDelegations: input.maxDelegations } });
				break;
			case "routing":
				if (typeof input.routing !== "boolean") return undefined;
				writes.push({ fileName: PREFERENCE_FILE_NAMES.routing, payload: { version: PREFERENCES_VERSION, routing: input.routing } });
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

function isModelSpec(value: unknown): value is ModelSpec {
	if (!isRecord(value) || typeof value.provider !== "string" || typeof value.modelId !== "string") return false;
	return parseModelSpec(`${value.provider}/${value.modelId}`) !== undefined;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
