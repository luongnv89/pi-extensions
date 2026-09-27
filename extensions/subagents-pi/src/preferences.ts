import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const PREFERENCES_FILE_NAME = "subagents-pi.json";
export const PREFERENCES_VERSION = 1;

export type SubagentsPreferences = {
	version: typeof PREFERENCES_VERSION;
	enabled: boolean;
};

export type SubagentsPreferencesPatch = {
	enabled?: boolean;
};

export function preferencesPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, PREFERENCES_FILE_NAME);
}

/** Read the validated durable subagents toggle, if one has been saved. */
export function loadPreferences(agentDir: string = getAgentDir()): SubagentsPreferencesPatch {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(preferencesPath(agentDir), "utf8"));
	} catch {
		return {};
	}
	if (!isRecord(parsed)) return {};
	if (parsed.version !== undefined && parsed.version !== PREFERENCES_VERSION) return {};
	return typeof parsed.enabled === "boolean" ? { enabled: parsed.enabled } : {};
}

/** Atomically replace the private preferences file with mode-0600 contents. */
export function savePreferences(enabled: boolean, agentDir: string = getAgentDir()): boolean {
	if (typeof enabled !== "boolean") return false;

	const targetPath = preferencesPath(agentDir);
	const temporaryPath = join(agentDir, `.${PREFERENCES_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
	let fileDescriptor: number | undefined;
	try {
		mkdirSync(agentDir, { recursive: true, mode: 0o700 });
		fileDescriptor = openSync(temporaryPath, "wx", 0o600);
		const preferences: SubagentsPreferences = { version: PREFERENCES_VERSION, enabled };
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
