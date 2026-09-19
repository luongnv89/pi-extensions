/**
 * The live "which model is running" display.
 *
 * Kept separate from the extension wiring because `ctx.hasUI` is false in print
 * mode, so benchmark and scripted runs never execute any of it. Isolating the
 * formatting and the UI calls behind a small interface lets them be tested
 * without a terminal.
 */

import { formatModelSpec, type ModelSpec } from "./config.js";
import { formatUsd } from "./metrics.js";

export const STATUS_KEY = "pi-fusion";

/** The colours this module asks for, narrowed to what Pi's theme accepts. */
export type StatusColor = "accent" | "warning";

export type UiLike = {
	setWorkingMessage: (message?: string) => void;
	setStatus: (key: string, text: string | undefined) => void;
	theme: { fg: (color: StatusColor, text: string) => string };
};

export type RunningState = {
	spec: ModelSpec;
	delegationIndex: number;
	maxDelegations: number;
	elapsedMs: number;
};

export type IdleState = {
	sidekick: ModelSpec;
	delegations: number;
	maxDelegations: number;
	saved: number;
	escalatedMain?: ModelSpec;
	struggling: boolean;
};

/** Footer space is tight: drop the provider and any vendor path prefix. */
export function shortModelName(spec: ModelSpec | undefined): string {
	if (!spec) return "none";
	const slash = spec.modelId.lastIndexOf("/");
	return slash >= 0 ? spec.modelId.slice(slash + 1) : spec.modelId;
}

/** Fully qualified: this is the line that answers "what is running right now". */
export function formatWorkingMessage(state: RunningState): string {
	return `Sidekick ${formatModelSpec(state.spec)} · delegation ${state.delegationIndex}/${state.maxDelegations} · ${seconds(state.elapsedMs)}s`;
}

export function formatRunningStatus(state: RunningState): string {
	return `fusion ▸ ${shortModelName(state.spec)} ${seconds(state.elapsedMs)}s`;
}

export function formatIdleStatus(state: IdleState): string {
	const warning = state.struggling ? "⚠ " : "";
	const escalated = state.escalatedMain ? `↑${shortModelName(state.escalatedMain)} ` : "";
	const saved = state.delegations > 0 && state.saved > 0 ? ` ~${formatUsd(state.saved)}` : "";
	return `fusion ${warning}${escalated}sk:${shortModelName(state.sidekick)} ${state.delegations}/${state.maxDelegations}${saved}`;
}

export function showRunning(ui: UiLike | undefined, state: RunningState): void {
	if (!ui) return;
	ui.setWorkingMessage(formatWorkingMessage(state));
	ui.setStatus(STATUS_KEY, ui.theme.fg("accent", formatRunningStatus(state)));
}

/** Always restores the default working row, even when the status is cleared. */
export function showIdle(ui: UiLike | undefined, state: IdleState | undefined): void {
	if (!ui) return;
	ui.setWorkingMessage();
	if (!state) {
		ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	ui.setStatus(STATUS_KEY, ui.theme.fg(state.struggling ? "warning" : "accent", formatIdleStatus(state)));
}

function seconds(elapsedMs: number): number {
	return Math.max(0, Math.round(elapsedMs / 1000));
}
