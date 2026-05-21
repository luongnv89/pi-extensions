/**
 * context-stats-pi Extension
 *
 * Real-time context window monitoring for Pi with live ASCII graphs,
 * Model Intelligence metrics, and zone indicators.
 *
 * Features:
 * - Live ASCII graph showing token consumption over time
 * - Model Intelligence (MI) score with color coding
 * - Zone indicators (Plan/Code/Dump/ExDump/Dead)
 * - Cost tracking and estimations
 * - Session state persistence
 * - Git status tracking (file changes, untracked files)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { StateManager } from "./state-manager";
import type { ContextSnapshot, GitStatus } from "./types";

const STATE_DIR = path.join(process.env.HOME || "/tmp", ".pi-context-stats");

export default function contextStatsPiExtension(pi: ExtensionAPI) {
	let stateManager: StateManager;
	let updateInterval: NodeJS.Timeout | undefined;
	let sessionStartTime: number = Date.now();

	// Initialize state directory
	if (!fs.existsSync(STATE_DIR)) {
		fs.mkdirSync(STATE_DIR, { recursive: true });
	}

	pi.on("session_start", async (event, ctx) => {
		if (!ctx.hasUI) return;

		// Initialize state manager for this session
		const sessionFile = ctx.sessionManager.getSessionFile();
		const sessionId = sessionFile
			? path.basename(sessionFile, ".jsonl").replace("session-", "")
			: "ephemeral-" + Date.now();

		stateManager = new StateManager(STATE_DIR, sessionId, ctx.cwd);
		sessionStartTime = Date.now();

		// Initial update
		updateStatusline(ctx);

		// Set up periodic updates (every 5 seconds)
		if (updateInterval) clearInterval(updateInterval);
		updateInterval = setInterval(() => {
			if (!ctx.isIdle?.()) {
				updateStatusline(ctx);
			}
		}, 5000);

		ctx.ui.notify("context-stats initialized", "info");
	});

	pi.on("message_end", async (event, ctx) => {
		if (!ctx.hasUI || !stateManager) return;

		const message = event.message;

		// Track message-level metrics
		if (message.role === "assistant" && message.usage) {
			const snapshot = captureSnapshot(ctx, message.usage);
			stateManager.recordSnapshot(snapshot);
			updateStatusline(ctx);
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!ctx.hasUI || !stateManager) return;

		// Update on tool results to capture incremental usage
		updateStatusline(ctx);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (updateInterval) clearInterval(updateInterval);
		if (stateManager) {
			stateManager.flush();
		}
	});

	pi.registerCommand("context-stats", {
		description: "Show context usage statistics and metrics",
		handler: async (args, ctx) => {
			if (!stateManager) {
				ctx.ui.notify("No session data available", "error");
				return;
			}

			const snapshot = captureSnapshot(ctx, ctx.getContextUsage?.());
			if (snapshot) {
				stateManager.recordSnapshot(snapshot);
				const report = stateManager.generateReport();
				ctx.ui.notify(report, "info");
			}
		},
	});


	// Helper functions
	function updateStatusline(ctx: ExtensionContext) {
		try {
			const snapshot = captureSnapshot(ctx, ctx.getContextUsage?.());
			if (!snapshot) return;

			// Calculate session-level tokens per second
			const sessionElapsedMs = Date.now() - sessionStartTime;
			const sessionElapsedSeconds = Math.max(1, sessionElapsedMs / 1000);
			const sessionTokensPerSecond = snapshot.tokensUsed / sessionElapsedSeconds;

			// Update status line only (no widget above editor)
			const zone = getZone(snapshot.contextUsageRatio, snapshot.contextWindow);
			const zoneColor = snapshot.contextUsageRatio > 0.7 ? "warning" : "success";
			const guidelines = getZoneGuidelines(zone);
			const speedIndicator = `${sessionTokensPerSecond.toFixed(1)} tok/s`;
			ctx.ui.setStatus(
				"context-stats",
				ctx.ui.theme.fg(zoneColor, `${getZoneEmoji(zone)} ${zone} Zone — ${guidelines} [${speedIndicator}]`),
			);
		} catch (error) {
			console.error("Error updating statusline:", error);
		}
	}

	function captureSnapshot(ctx: ExtensionContext, usage?: { tokens: number }): ContextSnapshot | null {
		if (!ctx.model) return null;

		const tokensUsed = usage?.tokens ?? 0;
		const contextWindow = ctx.model.contextWindow || 200000;
		const contextUsageRatio = contextWindow > 0 ? tokensUsed / contextWindow : 0;

		// Calculate tokens per second from session start
		const sessionElapsedMs = Date.now() - sessionStartTime;
		const sessionElapsedSeconds = Math.max(1, sessionElapsedMs / 1000);
		const tokensPerSecond = tokensUsed / sessionElapsedSeconds;

		// Capture git status
		const gitStatus = getGitStatus(ctx.cwd);

		return {
			timestamp: Date.now(),
			tokensUsed,
			contextWindow,
			contextUsageRatio,
			model: ctx.model.id,
			sessionId: ctx.sessionManager.getSessionFile?.()
				? path.basename(ctx.sessionManager.getSessionFile?.() || "", ".jsonl")
				: "ephemeral",
			cwd: ctx.cwd,
			tokensPerSecond,
			gitStatus,
		};
	}

	function getGitStatus(cwd: string): GitStatus | undefined {
		try {
			const output = execSync("git status --porcelain", {
				cwd,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
				timeout: 2_000,
			}).trim();

			const lines = output.split("\n").filter((line) => line.trim());
			let modified = 0;
			let untracked = 0;
			let staged = 0;

			for (const line of lines) {
				const status = line.substring(0, 2);
				if (status === "??") {
					untracked++;
					continue;
				}

				if (status[0] !== " " && status[0] !== "?") {
					staged++;
				}
				if (status[1] !== " " && status[1] !== "?") {
					modified++;
				}
			}

			return {
				modified,
				untracked,
				staged,
				total: modified + untracked + staged,
			};
		} catch (error) {
			// Silently fail if git command fails
			return undefined;
		}
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
				return "Safe to plan and code";
			case "Code":
				return "Finish current task";
			case "Dump":
				return "Consider `/compact` or subagent";
			case "ExDump":
				return "Run `/compact` now";
			case "Dead":
				return "Start new session with `/clear`";
			default:
				return "Unknown zone state";
		}
	}
}
