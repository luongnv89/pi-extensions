import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMetricsRow } from "./store.js";

const WIDGET_KEY = "subagents-pi-fleet";

export { WIDGET_KEY };

type Theme = ExtensionContext["ui"]["theme"];

export function renderFleetLines(
	theme: Theme,
	rows: AgentMetricsRow[],
	options: { companionReady: boolean; enabled: boolean },
	width: number,
): string[] {
	const safeWidth = Math.max(1, width);
	if (!options.enabled) return [];

	if (!options.companionReady) {
		return [
			truncateToWidth(theme.fg("warning", "subagents-pi · companion missing"), safeWidth),
			truncateToWidth(theme.fg("dim", "  pi install npm:@tintinweb/pi-subagents  ·  then /reload"), safeWidth),
		];
	}

	const running = rows.filter((row) => row.status === "running").length;
	const queued = rows.filter((row) => row.status === "queued").length;
	const other = Math.max(0, rows.length - running - queued);

	const lines: string[] = [truncateToWidth(formatHeader(theme, running, queued, other, safeWidth), safeWidth)];

	if (rows.length === 0) {
		lines.push(truncateToWidth(theme.fg("dim", "  No active subagents"), safeWidth));
		return lines;
	}

	for (const row of rows) {
		lines.push(...formatAgentLines(theme, row, safeWidth));
	}

	return lines;
}

function formatHeader(theme: Theme, running: number, queued: number, other: number, width: number): string {
	const title = theme.bold(theme.fg("mdHeading", "Subagents"));
	const parts: string[] = [];
	if (running > 0) parts.push(theme.fg("accent", `${running} active`));
	if (queued > 0) parts.push(theme.fg("warning", `${queued} queued`));
	if (other > 0) parts.push(theme.fg("dim", `${other} other`));
	if (parts.length === 0) parts.push(theme.fg("dim", "idle"));

	const summary = parts.join(theme.fg("dim", " · "));
	const left = `${title}  ${summary}`;
	const toggle = theme.fg("dim", "/subagents-pi");
	return padRight(left, toggle, width);
}

function formatAgentLines(theme: Theme, row: AgentMetricsRow, width: number): string[] {
	const glyph = statusGlyph(row.status);
	const statusColor = statusToColor(row.status);
	const marker = theme.fg(statusColor, glyph);
	const status = theme.fg(statusColor, compactStatus(row.status));
	const name = theme.fg("mdLink", row.type);
	const desc = theme.fg("dim", row.description);
	const identity = truncateToWidth(`  ${marker} ${status}  ${name}  ${desc}`, width);

	const primaryMetrics =
		row.status === "queued"
			? [
					theme.fg("warning", "waiting"),
					theme.fg("dim", row.duration),
					theme.fg("dim", `${row.toolUses} tools`),
				]
			: [
					theme.fg("accent", `ctx ${row.context}`),
					theme.fg("accent", `tps ${row.tps}`),
					theme.fg("dim", row.duration),
					theme.fg("dim", `${row.toolUses} tools`),
				];

	const secondaryMetrics = [theme.fg("accent", row.thinking), theme.fg("dim", row.model)];

	const sep = theme.fg("dim", "  ·  ");
	const metricLines = [
		...wrapSegments(primaryMetrics, sep, "    ", width),
		...wrapSegments(secondaryMetrics, sep, "    ", width),
	];

	return [identity, ...metricLines];
}

function compactStatus(status: string): string {
	switch (status) {
		case "running":
			return "run";
		case "queued":
			return "queue";
		case "steered":
			return "steer";
		default:
			return status.slice(0, 5);
	}
}

function statusGlyph(status: string): string {
	switch (status) {
		case "running":
			return "●";
		case "queued":
			return "○";
		case "steered":
			return "◎";
		default:
			return "·";
	}
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

function padRight(left: string, right: string, width: number): string {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	if (gap < 1) {
		return truncateToWidth(`${left}  ${right}`, width);
	}
	return `${left}${" ".repeat(gap)}${right}`;
}

function statusToColor(status: string): "success" | "warning" | "error" | "dim" | "accent" {
	switch (status) {
		case "running":
			return "accent";
		case "queued":
			return "warning";
		case "steered":
			return "success";
		case "error":
		case "aborted":
		case "stopped":
			return "error";
		default:
			return "dim";
	}
}
