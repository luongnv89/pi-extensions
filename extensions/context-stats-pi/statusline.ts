/**
 * ASCII graph rendering for context-stats-pi
 */

import type { ContextSnapshot, GitStatus } from "./types";
import { StateManager } from "./state-manager";

export function renderStatusline(
	current: ContextSnapshot,
	previous: ContextSnapshot | null,
	stateManager: StateManager,
): string[] {
	const lines: string[] = [];

	// Zone indicator with guidelines
	const zone = getZone(current.contextUsageRatio, current.contextWindow);
	const zoneEmoji = getZoneEmoji(zone);
	const guidelines = getZoneGuidelines(zone);

	lines.push(`${zoneEmoji} ${zone} Zone`);
	lines.push(`   ${guidelines}`);

	// Token speed indicator
	if (current.tokensPerSecond !== undefined) {
		const speedBar = renderSpeedBar(current.tokensPerSecond);
		lines.push(`   Speed: ${current.tokensPerSecond.toFixed(2)} tokens/sec ${speedBar}`);
	}

	// Git status indicator
	if (current.gitStatus && current.gitStatus.total > 0) {
		const gitStatusStr = formatGitStatus(current.gitStatus);
		lines.push(`   Git: ${gitStatusStr}`);
	}

	return lines;
}

function formatGitStatus(gitStatus: GitStatus): string {
	const parts: string[] = [];

	if (gitStatus.staged > 0) {
		parts.push(`📦 ${gitStatus.staged} staged`);
	}
	if (gitStatus.modified > 0) {
		parts.push(`✏️ ${gitStatus.modified} modified`);
	}
	if (gitStatus.untracked > 0) {
		parts.push(`❓ ${gitStatus.untracked} untracked`);
	}

	return parts.length > 0 ? parts.join(" | ") : "No changes";
}

function renderSpeedBar(tokensPerSecond: number): string {
	const maxSpeed = 100; // tokens/sec
	const barLength = 10;
	const filledLength = Math.min(barLength, Math.round((tokensPerSecond / maxSpeed) * barLength));
	const filled = "█".repeat(filledLength);
	const empty = "░".repeat(barLength - filledLength);
	return `[${filled}${empty}]`;
}

function getZone(contextUsageRatio: number, contextWindow: number): string {
	if (contextWindow >= 500_000) {
		// 1M-class model zones
		const used = contextWindow * contextUsageRatio;
		if (used < 150_000) return "Plan";
		if (used < 250_000) return "Code";
		if (used < 400_000) return "Dump";
		if (used < 450_000) return "ExDump";
		return "Dead";
	} else {
		// Standard model zones
		if (contextUsageRatio < 0.4) return "Plan";
		if (contextUsageRatio < 0.7) return "Code";
		if (contextUsageRatio < 0.75) return "Dump";
		if (contextUsageRatio < 0.8) return "ExDump";
		return "Dead";
	}
}

function getZoneEmoji(zone: string): string {
	switch (zone) {
		case "Plan":
			return "🟢";
		case "Code":
			return "🟡";
		case "Dump":
			return "🟠";
		case "ExDump":
			return "🔴";
		case "Dead":
			return "⚫";
		default:
			return "◻";
	}
}

function getZoneGuidelines(zone: string): string {
	switch (zone) {
		case "Plan":
			return "Safe to plan and code. Plenty of space for new context.";
		case "Code":
			return "Finish current task. Avoid starting new tasks.";
		case "Dump":
			return "Getting tight. Consider `/compact` or delegate to subagent.";
		case "ExDump":
			return "Critical. Run `/compact` now before quality degrades.";
		case "Dead":
			return "Start a new session with `/clear` to continue working.";
		default:
			return "Unknown zone state.";
	}
}
