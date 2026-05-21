/**
 * State management and persistence for context-stats-pi
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ContextSnapshot, StateEntry, Report } from "./types";

const ROTATION_THRESHOLD = 10_000;
const ROTATION_KEEP = 5_000;

export class StateManager {
	private stateDir: string;
	private sessionId: string;
	private cwd: string;
	private entries: StateEntry[] = [];
	private stateFile: string;

	constructor(stateDir: string, sessionId: string, cwd: string) {
		this.stateDir = stateDir;
		this.sessionId = sanitizeSessionId(sessionId);
		this.cwd = cwd;
		this.stateFile = path.join(stateDir, `session-${this.sessionId}.csv`);

		// Load existing state
		this.loadState();
	}

	private loadState() {
		if (!fs.existsSync(this.stateFile)) {
			return;
		}

		try {
			const content = fs.readFileSync(this.stateFile, "utf-8");
			const lines = content.split("\n").filter((line) => line.trim());

			for (const line of lines) {
				const entry = this.parseCSVLine(line);
				if (entry) {
					this.entries.push(entry);
				}
			}
		} catch (error) {
			console.error("Failed to load state:", error);
		}
	}

	recordSnapshot(snapshot: ContextSnapshot): void {
		const entry: StateEntry = {
			timestamp: snapshot.timestamp,
			tokensUsed: snapshot.tokensUsed,
			contextWindow: snapshot.contextWindow,
			model: snapshot.model,
			sessionId: snapshot.sessionId,
			cwd: snapshot.cwd,
			gitStatus: snapshot.gitStatus,
		};

		// Calculate tokens per second if we have a previous entry
		if (this.entries.length > 0) {
			const last = this.entries[this.entries.length - 1];
			if (last.tokensUsed === entry.tokensUsed && last.timestamp === entry.timestamp) {
				return;
			}

			const timeDeltaMs = entry.timestamp - last.timestamp;
			if (timeDeltaMs > 0) {
				const tokenDelta = entry.tokensUsed - last.tokensUsed;
				const timeDeltaSeconds = timeDeltaMs / 1000;
				entry.tokensPerSecond = tokenDelta / timeDeltaSeconds;
			}
		}

		this.entries.push(entry);
		this.maybeRotate();
	}

	private maybeRotate(): void {
		if (this.entries.length <= ROTATION_THRESHOLD) {
			return;
		}

		// Keep only the most recent ROTATION_KEEP entries
		this.entries = this.entries.slice(-ROTATION_KEEP);
		this.flush();
	}

	flush(): void {
		try {
			const lines = this.entries.map((entry) => this.entryToCSV(entry));
			fs.writeFileSync(this.stateFile, lines.join("\n") + "\n");
		} catch (error) {
			console.error("Failed to flush state:", error);
		}
	}

	getEntries(): StateEntry[] {
		return [...this.entries];
	}

	generateReport(): string {
		if (this.entries.length === 0) {
			return "No data collected yet";
		}

		const current = this.entries[this.entries.length - 1];
		const peak = Math.max(...this.entries.map((e) => e.tokensUsed));
		const average = Math.round(
			this.entries.reduce((sum, e) => sum + e.tokensUsed, 0) / this.entries.length,
		);

		const recentCount = this.entries.slice(-5).length;
		const previousCount = this.entries[Math.max(0, this.entries.length - 6)]?.tokensUsed ?? 0;
		const trend =
			recentCount > 0 && current.tokensUsed > previousCount
				? "increasing"
				: current.tokensUsed < previousCount
					? "decreasing"
					: "stable";

		// Calculate average tokens per second from entries with data
		const entriesWithTps = this.entries.filter((e) => e.tokensPerSecond !== undefined);
		const averageTps =
			entriesWithTps.length > 0
				? entriesWithTps.reduce((sum, e) => sum + (e.tokensPerSecond || 0), 0) / entriesWithTps.length
				: 0;

		const currentTps = current.tokensPerSecond ?? 0;

		return (
			`Context Stats Report\n` +
			`━━━━━━━━━━━━━━━━━━━━━\n` +
			`Current: ${current.tokensUsed.toLocaleString()} / ${current.contextWindow.toLocaleString()} tokens\n` +
			`Peak: ${peak.toLocaleString()} tokens\n` +
			`Average: ${average.toLocaleString()} tokens\n` +
			`Trend: ${trend}\n` +
			`Speed: ${currentTps.toFixed(2)} tokens/sec (avg: ${averageTps.toFixed(2)} tokens/sec)\n` +
			`Model: ${current.model}\n` +
			`Entries: ${this.entries.length}` +
			(current.gitStatus && current.gitStatus.total > 0
				? `\n\nGit Status\n` +
				  `━━━━━━━━━\n` +
				  `Total Changes: ${current.gitStatus.total}\n` +
				  `  Staged: ${current.gitStatus.staged}\n` +
				  `  Modified: ${current.gitStatus.modified}\n` +
				  `  Untracked: ${current.gitStatus.untracked}`
				: "")
		);
	}

	private parseCSVLine(line: string): StateEntry | null {
		const parts = line.split(",");
		if (parts.length < 6) {
			return null;
		}

		try {
			return {
				timestamp: parseInt(parts[0], 10),
				tokensUsed: parseInt(parts[1], 10),
				contextWindow: parseInt(parts[2], 10),
				model: parts[3] || "unknown",
				sessionId: parts[4] || "unknown",
				cwd: parts[5] || "",
				tokensPerSecond: parts[7] ? parseFloat(parts[7]) : undefined,
			};
		} catch {
			return null;
		}
	}

	private entryToCSV(entry: StateEntry): string {
		const tps = entry.tokensPerSecond !== undefined ? entry.tokensPerSecond.toFixed(2) : "";
		return `${entry.timestamp},${entry.tokensUsed},${entry.contextWindow},${entry.model},${entry.sessionId},${entry.cwd},,${tps}`;
	}
}

function sanitizeSessionId(sessionId: string): string {
	return sessionId.replace(/[\/\\..]/g, "-").substring(0, 50);
}
