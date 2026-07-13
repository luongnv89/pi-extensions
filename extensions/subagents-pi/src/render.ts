import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMetricsRow } from "./store.js";

const WIDGET_KEY = "subagents-pi-fleet";
const MAX_LINES = 14;

export { WIDGET_KEY };

export function renderFleetLines(
	theme: ExtensionContext["ui"]["theme"],
	rows: AgentMetricsRow[],
	options: { companionReady: boolean; enabled: boolean },
	width: number,
): string[] {
	const safeWidth = Math.max(20, width);
	if (!options.enabled) return [];

	if (!options.companionReady) {
		return [
			theme.fg("warning", "subagents-pi: install @tintinweb/pi-subagents and /reload"),
			theme.fg("dim", "  pi install npm:@tintinweb/pi-subagents"),
		];
	}

	if (rows.length === 0) {
		return [theme.fg("dim", "subagents-pi: no managed subagents in this session")];
	}

	const header = theme.bold(theme.fg("mdHeading", `Subagents (${rows.length})`));
	const lines: string[] = [truncateToWidth(header, safeWidth)];

	const displayRows = rows.slice(0, MAX_LINES);
	for (const row of displayRows) {
		lines.push(truncateToWidth(formatAgentLine(theme, row), safeWidth));
	}

	if (rows.length > MAX_LINES) {
		lines.push(theme.fg("dim", truncateToWidth(`  … +${rows.length - MAX_LINES} more`, safeWidth)));
	}

	lines.push(
		truncateToWidth(
			theme.fg(
				"dim",
				"context · tps · model · thinking — /subagents-pi to toggle",
			),
			safeWidth,
		),
	);
	return lines;
}

function formatAgentLine(theme: ExtensionContext["ui"]["theme"], row: AgentMetricsRow): string {
	const statusColor = statusToColor(row.status);
	const status = theme.fg(statusColor, row.status.padEnd(9));
	const name = theme.fg("mdLink", row.type);
	const desc = theme.fg("dim", row.description);
	const metrics = theme.fg(
		"accent",
		`ctx ${row.context} · ${row.tps} tps · ${row.model} · think ${row.thinking}`,
	);
	const meta = theme.fg("dim", ` · ${row.duration} · ${row.toolUses} tools`);
	return `  ${status} ${name} ${desc} — ${metrics}${meta}`;
}

function statusToColor(status: string): "success" | "warning" | "error" | "dim" | "accent" {
	switch (status) {
		case "running":
			return "accent";
		case "queued":
			return "warning";
		case "completed":
			return "success";
		case "error":
		case "aborted":
		case "stopped":
			return "error";
		default:
			return "dim";
	}
}