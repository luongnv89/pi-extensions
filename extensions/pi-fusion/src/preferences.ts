import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

export const PREFERENCES_FILE_NAME = "pi-fusion.json";
export const PREFERENCES_VERSION = 1;

export function preferencesPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, PREFERENCES_FILE_NAME);
}

/**
 * Read durable settings independently. Missing, malformed, or stale files are
 * treated as no preferences; one invalid field does not discard valid fields.
 */
export function loadPreferences(agentDir: string = getAgentDir()): FusionConfigPatch {
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

/** Load preferences on top of unchanged defaults for a fresh runtime. */
export function loadConfig(agentDir: string = getAgentDir()): FusionConfig {
	return normalizeConfig(loadPreferences(agentDir), defaultConfig());
}

/** Merge and persist one deliberate user edit, without branch/session state. */
export function savePreferencesPatch(patch: FusionConfigPatch, agentDir: string = getAgentDir()): boolean {
	return savePreferences({ ...loadPreferences(agentDir), ...patch }, agentDir);
}

/** Atomically replace the private sparse preference file with mode-0600 contents. */
export function savePreferences(config: FusionConfigPatch, agentDir: string = getAgentDir()): boolean {
	const targetPath = preferencesPath(agentDir);
	const temporaryPath = join(agentDir, `.${PREFERENCES_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
	let fileDescriptor: number | undefined;
	try {
		mkdirSync(agentDir, { recursive: true, mode: 0o700 });
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

function validatedPatch(input: unknown): FusionConfigPatch {
	const patch: FusionConfigPatch = {};
	if (!isRecord(input)) return patch;
	if (typeof input.enabled === "boolean") patch.enabled = input.enabled;
	if (isModelSpec(input.sidekick)) patch.sidekick = input.sidekick;
	if (input.sidekickUpgrade === null) patch.sidekickUpgrade = null;
	else if (isModelSpec(input.sidekickUpgrade)) patch.sidekickUpgrade = input.sidekickUpgrade;
	if (input.frontier === null) patch.frontier = null;
	else if (isModelSpec(input.frontier)) patch.frontier = input.frontier;
	const thinkingLevel = parseThinkingLevel(input.thinkingLevel);
	if (thinkingLevel) patch.thinkingLevel = thinkingLevel;
	const toolMode = parseToolMode(input.toolMode);
	if (toolMode) patch.toolMode = toolMode;
	if (isPositiveSafeInteger(input.maxDelegations)) patch.maxDelegations = input.maxDelegations;
	if (typeof input.routing === "boolean") patch.routing = input.routing;
	return patch;
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
