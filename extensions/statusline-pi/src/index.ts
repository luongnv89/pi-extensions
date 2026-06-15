import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import {
	addAssistantMessageCost,
	aggregateSessionCostFromContext,
	createEmptySessionCostState,
	formatCostSection,
	type SessionCostState,
} from "./cost.js";

interface GitInfo {
	branch?: string;
	changedFiles: number;
	prNumber?: number;
}

interface ResponseSpeedInfo {
	tokensPerSecond?: number;
	outputTokens: number;
	durationMs: number;
	responseCount: number;
	inProgress: boolean;
}

interface ResponseSpeedAggregate {
	totalOutputTokens: number;
	totalDurationMs: number;
	responseCount: number;
}

interface CurrentResponseSpeed {
	outputTokens: number;
	durationMs: number;
	inProgress: boolean;
}

const GIT_REFRESH_MS = 5_000;
const PR_REFRESH_MS = 60_000;
const SPEED_RENDER_THROTTLE_MS = 250;
const NARROW_BRANCH_WIDTH_RATIO = 0.55;
const MIN_NARROW_BRANCH_WIDTH = 8;

export default function statuslinePiExtension(pi: ExtensionAPI) {
	let enabled = true;
	let gitInfo: GitInfo = { changedFiles: 0 };
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let lastGitRefresh = 0;
	let lastPrRefresh = 0;
	let lastPrBranch: string | undefined;
	let renderRequested: (() => void) | undefined;
	let responseSpeed: ResponseSpeedInfo | undefined;
	let completedResponseSpeed = createEmptyResponseSpeedAggregate();
	let responseStartMs: number | undefined;
	let liveOutputTokenEstimate = 0;
	let lastSpeedRender = 0;
	let sessionCost = createEmptySessionCostState();

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		mount(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
		renderRequested = undefined;
		resetResponseSpeed();
		sessionCost = createEmptySessionCostState();
	});

	pi.on("model_select", async (_event, ctx) => {
		resetResponseSpeed();
		sessionCost = aggregateSessionCostFromContext(ctx);
		requestRender();
	});
	pi.on("thinking_level_select", async (_event, _ctx) => {
		resetResponseSpeed();
		requestRender();
	});
	pi.on("message_start", async (event, _ctx) => {
		if (event.message.role !== "assistant") return;

		responseStartMs = Date.now();
		liveOutputTokenEstimate = 0;
		responseSpeed = getAverageResponseSpeed(completedResponseSpeed, {
			outputTokens: 0,
			durationMs: 0,
			inProgress: true,
		});
		requestRender();
	});
	pi.on("message_update", async (event, _ctx) => {
		if (event.message.role !== "assistant" || responseStartMs === undefined) return;

		const streamEvent = event.assistantMessageEvent;
		if (
			streamEvent.type === "text_delta" ||
			streamEvent.type === "thinking_delta" ||
			streamEvent.type === "toolcall_delta"
		) {
			liveOutputTokenEstimate += estimateTokens(streamEvent.delta);
		}

		const durationMs = Date.now() - responseStartMs;
		responseSpeed = getAverageResponseSpeed(completedResponseSpeed, {
			outputTokens: Math.round(liveOutputTokenEstimate),
			durationMs,
			inProgress: true,
		});
		requestSpeedRender();
	});
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") {
			requestRender();
			return;
		}

		const durationMs = responseStartMs === undefined ? 0 : Date.now() - responseStartMs;
		const outputTokens = event.message.usage?.output || estimateAssistantOutputTokens(event.message) || Math.round(liveOutputTokenEstimate);
		if (responseStartMs !== undefined) {
			completedResponseSpeed = addCompletedResponseSpeed(completedResponseSpeed, outputTokens, durationMs);
		}
		responseSpeed = getAverageResponseSpeed(completedResponseSpeed);
		responseStartMs = undefined;
		liveOutputTokenEstimate = 0;
		sessionCost = addAssistantMessageCost(sessionCost, event.message.usage, ctx.model);
		requestRender();
	});
	pi.on("tool_result", async (_event, ctx) => {
		refreshGit(ctx.cwd, { forceGit: true });
		requestRender();
	});

	pi.registerCommand("statusline-pi", {
		description: "Toggle the compact project statusline footer",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			enabled = !enabled;

			if (enabled) {
				mount(ctx);
				ctx.ui.notify("statusline-pi enabled", "info");
			} else {
				unmount(ctx);
				ctx.ui.notify("statusline-pi disabled", "info");
			}
		},
	});

	pi.registerCommand("statusline-refresh", {
		description: "Refresh statusline-pi git and PR data",
		handler: async (_args, ctx) => {
			refreshGit(ctx.cwd, { forceGit: true, forcePr: true });
			requestRender();
			ctx.ui.notify("statusline-pi refreshed", "info");
		},
	});

	function mount(ctx: ExtensionContext): void {
		if (!enabled || !ctx.hasUI) return;

		sessionCost = aggregateSessionCostFromContext(ctx);
		refreshGit(ctx.cwd, { forceGit: true, forcePr: true });

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribeBranch = footerData.onBranchChange(() => {
				refreshGit(ctx.cwd, { forceGit: true, forcePr: true });
				tui.requestRender();
			});

			renderRequested = () => tui.requestRender();

			return {
				dispose() {
					unsubscribeBranch();
				},
				invalidate() {
					tui.requestRender();
				},
				render(width: number): string[] {
					const usage = getUsage(ctx);
					const zone = getZone(usage.usedRatio, usage.contextWindow);
					const cost = formatCostSection(theme, sessionCost, ctx);
					const model = formatModelName(ctx, pi);
					const dir = path.basename(ctx.cwd) || ctx.cwd;
					const branch = gitInfo.branch ?? footerData.getGitBranch?.() ?? "no-git";
					const changed = gitInfo.changedFiles;
					const separator = theme.fg("borderMuted", " │ ");

					const statuslines = formatResponsiveStatusline(
						{
							dir: theme.fg("mdLink", dir),
							git: formatGitSection(theme, branch, changed, gitInfo.prNumber),
							compactGit: formatGitSection(
								theme,
								branch,
								changed,
								gitInfo.prNumber,
								getNarrowBranchWidth(width),
							),
							context: formatContextSection(theme, usage, zone),
							speed: formatSpeedSection(theme, responseSpeed),
							cost,
							model: theme.fg("mdLink", model),
						},
						separator,
						width,
					);
					const extensionStatuses = Array.from(footerData.getExtensionStatuses?.().values() ?? []).map((status) =>
						truncateToWidth(status, width),
					);

					return [...statuslines, ...extensionStatuses];
				},
			};
		});

		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = setInterval(() => {
			refreshGit(ctx.cwd);
			requestRender();
		}, GIT_REFRESH_MS);
	}

	function unmount(ctx: ExtensionContext): void {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
		renderRequested = undefined;
		ctx.ui.setFooter(undefined);
	}

	function requestRender(): void {
		renderRequested?.();
	}

	function requestSpeedRender(): void {
		const now = Date.now();
		if (now - lastSpeedRender < SPEED_RENDER_THROTTLE_MS) return;
		lastSpeedRender = now;
		requestRender();
	}

	function resetResponseSpeed(): void {
		responseSpeed = undefined;
		completedResponseSpeed = createEmptyResponseSpeedAggregate();
		responseStartMs = undefined;
		liveOutputTokenEstimate = 0;
		lastSpeedRender = 0;
	}

	function refreshGit(cwd: string, options: { forceGit?: boolean; forcePr?: boolean } = {}): void {
		const now = Date.now();
		if (!options.forceGit && now - lastGitRefresh < GIT_REFRESH_MS) return;
		lastGitRefresh = now;

		const previousBranch = gitInfo.branch;
		const branch = runGit(cwd, ["branch", "--show-current"]) || runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
		const porcelain = runGit(cwd, ["status", "--porcelain"]);
		const changedFiles = porcelain ? porcelain.split("\n").filter((line) => line.trim()).length : 0;

		gitInfo = {
			...gitInfo,
			branch: branch || undefined,
			changedFiles,
		};

		if (previousBranch !== gitInfo.branch) {
			lastPrBranch = undefined;
			lastPrRefresh = 0;
			gitInfo.prNumber = undefined;
		}

		refreshPr(cwd, options.forcePr);
	}

	function refreshPr(cwd: string, force = false): void {
		if (!gitInfo.branch) return;

		const now = Date.now();
		const refreshInterval = gitInfo.prNumber ? PR_REFRESH_MS : GIT_REFRESH_MS;
		if (!force && lastPrBranch === gitInfo.branch && now - lastPrRefresh < refreshInterval) return;

		lastPrBranch = gitInfo.branch;
		lastPrRefresh = now;

		try {
			const output = execFileSync("gh", ["pr", "view", "--json", "number", "--jq", ".number"], {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 3_000,
			}).trim();
			const number = Number(output);
			gitInfo.prNumber = Number.isFinite(number) && number > 0 ? number : undefined;
		} catch {
			gitInfo.prNumber = undefined;
		}
	}
}

function runGit(cwd: string, args: string[]): string {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2_000,
		}).trim();
	} catch {
		return "";
	}
}

function getUsage(ctx: ExtensionContext): {
	contextWindow: number;
	usedTokens: number;
	usedRatio: number;
	remainingTokens: number;
	remainingPercent: number;
} {
	const contextWindow = ctx.model?.contextWindow ?? 0;
	const usedTokens = ctx.getContextUsage?.()?.tokens ?? 0;
	const usedRatio = contextWindow > 0 ? Math.min(1, usedTokens / contextWindow) : 0;
	const remainingTokens = Math.max(0, contextWindow - usedTokens);
	const remainingPercent = contextWindow > 0 ? (remainingTokens / contextWindow) * 100 : 0;

	return {
		contextWindow,
		usedTokens,
		usedRatio,
		remainingTokens,
		remainingPercent,
	};
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

export interface StatuslineSegments {
	dir: string;
	git: string;
	compactGit: string;
	context: string;
	speed: string;
	cost: string;
	model: string;
}

export function formatResponsiveStatusline(segments: StatuslineSegments, separator: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const wideLine = [segments.dir, segments.git, segments.cost, segments.context, segments.speed, segments.model]
		.filter(Boolean)
		.join(separator);
	if (visibleWidth(wideLine) <= safeWidth) return [wideLine];

	return [
		...formatStatuslineGroup([segments.dir, segments.compactGit, segments.cost], separator, safeWidth),
		...formatStatuslineGroup([segments.context, segments.speed, segments.model], separator, safeWidth),
	];
}

function formatStatuslineGroup(segments: string[], separator: string, width: number): string[] {
	const line = segments.filter(Boolean).join(separator);
	if (visibleWidth(line) <= width) return [line];
	return segments.filter(Boolean).map((segment) => truncateToWidth(segment, width));
}

export function getNarrowBranchWidth(width: number): number {
	return Math.max(MIN_NARROW_BRANCH_WIDTH, Math.floor(width * NARROW_BRANCH_WIDTH_RATIO));
}

export function truncatePlainTextToWidth(text: string, maxWidth: number, ellipsis = "…"): string {
	if (visibleWidth(text) <= maxWidth) return text;

	const targetWidth = Math.max(0, maxWidth - visibleWidth(ellipsis));
	let output = "";
	for (const character of text) {
		if (visibleWidth(output + character) > targetWidth) break;
		output += character;
	}
	return `${output}${ellipsis}`;
}

export function formatGitSection(
	theme: ExtensionContext["ui"]["theme"],
	branch: string,
	changedFiles: number,
	prNumber?: number,
	maxBranchWidth?: number,
): string {
	const branchDisplay = maxBranchWidth === undefined ? branch : truncatePlainTextToWidth(branch, maxBranchWidth);
	const branchText = theme.fg("mdLink", branchDisplay);
	const changesColor = changedFiles > 0 ? "warning" : "dim";
	const changesText = theme.fg(changesColor, `[${changedFiles}]`);
	const prText = prNumber ? ` ${theme.fg("mdHeading", `PR #${prNumber}`)}` : "";
	return `${branchText} ${changesText}${prText}`;
}

function formatContextSection(
	theme: ExtensionContext["ui"]["theme"],
	usage: ReturnType<typeof getUsage>,
	zone: string,
): string {
	const color = getZoneColor(zone);
	return theme.fg(color, `${usage.remainingTokens.toLocaleString()} (${usage.remainingPercent.toFixed(1)}%) ${zone}`);
}

function formatSpeedSection(theme: ExtensionContext["ui"]["theme"], speed: ResponseSpeedInfo | undefined): string {
	if (!speed) return theme.fg("dim", "-- tok/s");

	const speedText = speed.tokensPerSecond === undefined ? "--" : formatTokensPerSecond(speed.tokensPerSecond);
	const suffix = speed.inProgress ? "…" : "";
	return theme.fg(getSpeedColor(speed), `${speedText} tok/s${suffix}`);
}

function getZoneColor(zone: string): "success" | "warning" | "error" | "dim" {
	switch (zone) {
		case "Plan":
		case "Code":
			return "success";
		case "Dump":
			return "warning";
		case "ExDump":
		case "Dead":
			return "error";
		default:
			return "dim";
	}
}

function getSpeedColor(speed: ResponseSpeedInfo): "success" | "warning" | "error" | "dim" {
	const tokensPerSecond = speed.tokensPerSecond;
	if (tokensPerSecond === undefined || tokensPerSecond <= 0) return "dim";
	if (tokensPerSecond >= 20) return "success";
	if (tokensPerSecond >= 5) return "warning";
	return "error";
}

function formatTokensPerSecond(tokensPerSecond: number): string {
	if (tokensPerSecond < 100) return tokensPerSecond.toFixed(1);
	return Math.round(tokensPerSecond).toString();
}

function calculateTokensPerSecond(tokens: number, durationMs: number): number | undefined {
	if (tokens <= 0 || durationMs <= 0) return undefined;
	return tokens / (durationMs / 1000);
}

function createEmptyResponseSpeedAggregate(): ResponseSpeedAggregate {
	return {
		totalOutputTokens: 0,
		totalDurationMs: 0,
		responseCount: 0,
	};
}

function addCompletedResponseSpeed(
	aggregate: ResponseSpeedAggregate,
	outputTokens: number,
	durationMs: number,
): ResponseSpeedAggregate {
	if (outputTokens <= 0 || durationMs <= 0) return aggregate;

	return {
		totalOutputTokens: aggregate.totalOutputTokens + outputTokens,
		totalDurationMs: aggregate.totalDurationMs + durationMs,
		responseCount: aggregate.responseCount + 1,
	};
}

function getAverageResponseSpeed(
	completed: ResponseSpeedAggregate,
	current?: CurrentResponseSpeed,
): ResponseSpeedInfo | undefined {
	const hasCurrentData = current !== undefined && current.outputTokens > 0 && current.durationMs > 0;
	const outputTokens = completed.totalOutputTokens + (hasCurrentData ? current.outputTokens : 0);
	const durationMs = completed.totalDurationMs + (hasCurrentData ? current.durationMs : 0);
	const responseCount = completed.responseCount + (hasCurrentData ? 1 : 0);
	const inProgress = current?.inProgress ?? false;
	const tokensPerSecond = calculateTokensPerSecond(outputTokens, durationMs);

	if (tokensPerSecond === undefined && !inProgress) return undefined;

	return {
		tokensPerSecond,
		outputTokens,
		durationMs,
		responseCount,
		inProgress,
	};
}

function estimateTokens(text: string): number {
	return Math.max(1, text.length / 4);
}

function estimateAssistantOutputTokens(message: { content: Array<{ type: string; text?: string; thinking?: string; arguments?: unknown }> }): number {
	let characters = 0;
	for (const block of message.content) {
		if (block.type === "text") characters += block.text?.length ?? 0;
		else if (block.type === "thinking") characters += block.thinking?.length ?? 0;
		else if (block.type === "toolCall") characters += JSON.stringify(block.arguments ?? {}).length;
	}
	return Math.ceil(characters / 4);
}

function formatModelName(ctx: ExtensionContext, pi: ExtensionAPI): string {
	const provider = ctx.model?.provider;
	const model = ctx.model?.id ? ctx.model.id.replace(/^models\//, "") : "no-model";
	const supportsReasoning = ctx.model?.reasoning ?? false;
	const thinking = pi.getThinkingLevel?.() ?? "off";
	const thinkingDisplay = thinking !== "off" ? thinking : supportsReasoning ? "T" : "–";
	const modelPart = provider ? `${provider}/${model}` : model;
	return `${modelPart} [${thinkingDisplay}]`;
}
