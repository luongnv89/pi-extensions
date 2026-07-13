import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMetricsRow } from "./store.js";

const WIDGET_KEY = "subagents-pi-fleet";

export { WIDGET_KEY };

export function renderFleetLines(
	theme: ExtensionContext["ui"]["theme"],
	rows: AgentMetricsRow[],
	options: { companionReady: boolean; enabled: boolean },
	width: number,
): string[] {
	const safeWidth = Math.max(1, width);
	if (!options.enabled) return [];

	if (!options.companionReady) {
		return [
			truncateToWidth(theme.fg("warning", "subagents-pi: install @tintinweb/pi-subagents and /reload"), safeWidth),
			truncateToWidth(theme.fg("dim", "  pi install npm:@tintinweb/pi-subagents"), safeWidth),
		];
	}

	if (rows.length === 0) {
		return [truncateToWidth(theme.fg("dim", "subagents-pi: no managed subagents in this session"), safeWidth)];
	}

	const header = theme.bold(theme.fg("mdHeading", `Subagents (${rows.length})`));
	const lines: string[] = [truncateToWidth(header, safeWidth)];

	for (const row of rows) {
		lines.push(...formatAgentLines(theme, row, safeWidth));
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

function formatAgentLines(
	theme: ExtensionContext["ui"]["theme"],
	row: AgentMetricsRow,
	width: number,
): string[] {
	const statusColor = statusToColor(row.status);
	const status = theme.fg(statusColor, row.status.padEnd(9));
	const name = theme.fg("mdLink", row.type);
	const desc = theme.fg("dim", row.description);
	const identity = truncateToWidth(`  ${status} ${name} ${desc}`, width);
	const metrics = [
		theme.fg("accent", `ctx ${row.context}`),
		theme.fg("accent", `tps ${row.tps}`),
		theme.fg("accent", `model ${row.model}`),
		theme.fg("accent", `think ${row.thinking}`),
		theme.fg("dim", `${row.duration} · ${row.toolUses} tools`),
	];
	return [identity, ...wrapSegments(metrics, theme.fg("dim", " · "), "    ", width)];
}

function wrapSegments(segments: string[], separator: string, indent: string, width: number): string[] {
	const lines: string[] = [];
	let line = indent;

	for (const segment of segments) {
		const candidate = line === indent ? `${indent}${segment}` : `${line}${separator}${segment}`;
		if (visibleWidth(candidate) <= width) {
			line = candidate;
			continue;
		}
		if (line !== indent) lines.push(line);
		const standalone = `${indent}${segment}`;
		if (visibleWidth(standalone) <= width) {
			line = standalone;
		} else {
			lines.push(truncateToWidth(standalone, width));
			line = indent;
		}
	}

	if (line !== indent) lines.push(line);
	return lines;
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