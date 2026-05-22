import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";
import * as path from "node:path";

interface GitInfo {
	branch?: string;
	changedFiles: number;
	prNumber?: number;
}

const GIT_REFRESH_MS = 5_000;
const PR_REFRESH_MS = 60_000;

export default function statuslinePiExtension(pi: ExtensionAPI) {
	let enabled = true;
	let gitInfo: GitInfo = { changedFiles: 0 };
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let lastGitRefresh = 0;
	let lastPrRefresh = 0;
	let lastPrBranch: string | undefined;
	let renderRequested: (() => void) | undefined;

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		mount(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
		renderRequested = undefined;
	});

	pi.on("model_select", async (_event, _ctx) => requestRender());
	pi.on("thinking_level_select", async (_event, _ctx) => requestRender());
	pi.on("message_end", async (_event, _ctx) => requestRender());
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
					const model = formatModelName(ctx, pi);
					const dir = path.basename(ctx.cwd) || ctx.cwd;
					const branch = gitInfo.branch ?? footerData.getGitBranch?.() ?? "no-git";
					const changed = gitInfo.changedFiles;

					const segments = [
						theme.fg("mdLink", dir),
						formatGitSection(theme, branch, changed, gitInfo.prNumber),
						formatContextSection(theme, usage, zone),
						theme.fg("mdLink", model),
					].filter((segment): segment is string => Boolean(segment));

					const separator = theme.fg("borderMuted", " │ ");
					const statusline = truncateToWidth(segments.join(separator), width);
					const extensionStatuses = Array.from(footerData.getExtensionStatuses?.().values() ?? []).map((status) =>
						truncateToWidth(status, width),
					);

					return [statusline, ...extensionStatuses];
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

function formatGitSection(
	theme: ExtensionContext["ui"]["theme"],
	branch: string,
	changedFiles: number,
	prNumber?: number,
): string {
	const branchText = theme.fg("mdLink", branch);
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

function formatModelName(ctx: ExtensionContext, pi: ExtensionAPI): string {
	const provider = ctx.model?.provider;
	const model = ctx.model?.id ? ctx.model.id.replace(/^models\//, "") : "no-model";
	const supportsReasoning = ctx.model?.reasoning ?? false;
	const thinking = pi.getThinkingLevel?.() ?? "off";
	const thinkingDisplay = thinking !== "off" ? thinking : supportsReasoning ? "T" : "–";
	const modelPart = provider ? `${provider}/${model}` : model;
	return `${modelPart} [${thinkingDisplay}]`;
}
