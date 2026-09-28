import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { buildMenuRows, DURATION_OPTIONS, formatRateCap, RATE_OPTIONS, rowForLabel } from "./config-ui.js";
import { formatDurationMs, parseCacheWarmArgs, parseDurationMs } from "./command.js";
import { formatMetrics } from "./metrics.js";
import { loadPreferences, savePreferencesPatch, type CacheWarmPreferencesPatch } from "./preferences.js";
import {
	applyAssistantUsage,
	applyModelChange,
	beginWarmDispatch,
	confirmWarmDispatch,
	createWarmState,
	ENTRY_TYPE,
	expirePendingDispatch,
	failPendingDispatch,
	formatStatusReport,
	formatWarmFooter,
	isActiveWindowOpen,
	markWarmAbortCalled,
	modelKeyOf,
	noteAgentSettled,
	noteAgentStart,
	noteExternalInput,
	noteExternalMessageStart,
	noteTurnStart,
	noteUserActivity,
	resetSession,
	setActiveMs,
	setEnabled,
	setRateLimitEnabled,
	shouldSendWarmPing,
	STATUS_KEY,
	buildPingContent,
} from "./warm.js";

export { CACHE_TTL_LONG_MS, CACHE_TTL_MS, CACHE_WARN_MS, computeCacheStatus, formatCountdown } from "./cache.js";
export { formatDurationMs, parseCacheWarmArgs, parseDurationMs } from "./command.js";
export type { CacheWarmAction, ParsedCacheWarmArgs } from "./command.js";
export {
	cloneUsage,
	createMetrics,
	estimateGrossBenefitUsd,
	estimateTurnUsd,
	formatMetrics,
	formatUsd,
	hasCacheActivity,
	inferMissBillingMode,
	netUsdSaved,
	normalizeUsage,
} from "./metrics.js";
export type { Metrics, MissBillingMode, TokenUsage } from "./metrics.js";
export { loadPreferences, PREFERENCE_FILE_NAMES, preferencesPath, savePreferences, savePreferencesPatch } from "./preferences.js";
export type { CacheWarmPreferences, CacheWarmPreferencesPatch } from "./preferences.js";
export {
	applyAssistantUsage,
	applyModelChange,
	beginWarmDispatch,
	closeChain,
	confirmWarmDispatch,
	createWarmState,
	ENTRY_TYPE,
	expirePendingDispatch,
	failPendingDispatch,
	DEFAULT_ACTIVE_MS,
	formatStatusReport,
	formatWarmFooter,
	isActiveWindowOpen,
	markWarmAbortCalled,
	modelKeyOf,
	noteAgentSettled,
	noteAgentStart,
	noteExternalInput,
	noteExternalMessageStart,
	noteTurnStart,
	noteUserActivity,
	PING_CONTENT,
	RATE_WINDOW_MS,
	DEFAULT_MAX_PINGS_PER_HOUR,
	buildPingContent,
	pingsInWindow,
	underRateLimit,
	remainingActiveMs,
	resetSession,
	setActiveMs,
	setEnabled,
	setRateLimitEnabled,
	shouldSendWarmPing,
	STATUS_KEY,
	WARM_TIMEOUT_MS,
} from "./warm.js";
export type {
	CacheRetentionState,
	PendingTurn,
	RetentionKind,
	WarmDispatch,
	WarmPingGate,
	WarmRun,
	WarmState,
} from "./warm.js";

const TICK_MS = 1_000;
const TOOL_BLOCK_REASON = "cache-warm hidden turns cannot call tools";
const DISPATCH_ID_KEY = "cacheWarmDispatchId";

export default function cacheWarmExtension(pi: ExtensionAPI) {
	const state = createWarmState(loadPreferences());
	let timer: ReturnType<typeof setInterval> | undefined;
	let mountedCtx: ExtensionContext | undefined;

	if (typeof pi.registerFlag === "function") {
		pi.registerFlag("cache-warm-enabled", {
			description: "Enable prompt-cache keep-alive for this session (billable)",
			type: "boolean",
		});
		pi.registerFlag("cache-warm-duration", {
			description: "Idle auto-stop duration, e.g. 30m, 1h, or forever",
			type: "string",
		});
		pi.registerFlag("cache-warm-rate", {
			description: "Hourly warm-ping rate limit: on or off",
			type: "string",
		});
		pi.registerFlag("cache-warm-rate-limit", {
			description: "Alias for --cache-warm-rate",
			type: "string",
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		applyStartupFlags(state, pi);
		mountedCtx = ctx;
		applyModelChange(state, modelKeyOf(ctx.model));
		noteUserActivity(state, Date.now());
		if (state.enabled) startTimer();
		syncStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopTimer();
		resetSession(state);
		if (mountedCtx?.hasUI) mountedCtx.ui.setStatus(STATUS_KEY, undefined);
		mountedCtx = undefined;
	});

	pi.on("model_select", async (event, ctx) => {
		if (applyModelChange(state, modelKeyOf(event.model ?? ctx.model))) ctx.abort();
		syncStatus(ctx);
	});

	pi.on("input", async (_event, ctx) => {
		if (noteExternalInput(state)) ctx.abort();
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (noteExternalInput(state)) ctx.abort();
	});

	pi.on("agent_start", async () => {
		noteAgentStart(state);
	});

	pi.on("turn_start", async (event) => {
		noteTurnStart(state, event.timestamp);
	});

	pi.on("message_start", async (event, ctx) => {
		const message = event.message as {
			role?: string;
			customType?: string;
			details?: Record<string, unknown>;
		};
		const dispatchId =
			message.role === "custom" && message.customType === ENTRY_TYPE
				? message.details?.[DISPATCH_ID_KEY]
				: undefined;
		if (typeof dispatchId === "string") {
			const result = confirmWarmDispatch(state, dispatchId);
			if (result.abort && markWarmAbortCalled(state)) ctx.abort();
			return;
		}
		if (message.role === "user" || message.role === "custom") {
			noteExternalMessageStart(state);
		}
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message as { role?: string; usage?: Partial<Usage> };
		if (message.role !== "assistant") return;
		applyAssistantUsage(state, {
			usage: message.usage,
			model: ctx.model as Model<any> | undefined,
		});
		syncStatus(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		noteAgentSettled(state);
		syncStatus(ctx);
	});

	pi.on("tool_call", async () => {
		if (!state.warmRunActive) return;
		return { block: true, reason: TOOL_BLOCK_REASON, terminate: true };
	});

	pi.registerCommand("cache-warm", {
		description: "Enable, disable, or show prompt-cache keep-alive status and savings",
		handler: async (args, ctx) => {
			mountedCtx = ctx;
			const trimmed = args.trim();
			// Bare `/cache-warm` opens a selector only in the terminal TUI. RPC,
			// print, and JSON callers retain the legacy toggle behavior.
			if (!trimmed && ctx.mode === "tui" && ctx.hasUI) {
				await openConfigPanel(ctx);
				return;
			}
			await applyCommand(parseCacheWarmArgs(args), ctx);
		},
	});

	async function applyCommand(
		parsed: ReturnType<typeof parseCacheWarmArgs>,
		ctx: ExtensionContext,
		options: { confirmEnable?: boolean } = {},
	): Promise<boolean> {
		switch (parsed.action) {
			case "on":
				if (options.confirmEnable && !(await confirmEnable(ctx))) return false;
				enable(ctx);
				notify(ctx, "cache-warm enabled", "info");
				return true;
			case "off":
				disable(ctx);
				notify(ctx, "cache-warm disabled", "info");
				return true;
			case "toggle":
				return applyCommand(parseCacheWarmArgs(state.enabled ? "off" : "on"), ctx, options);
			case "status":
				notify(ctx, formatStatusReport(state, Date.now()), "info");
				return true;
			case "metrics":
				notify(ctx, formatMetrics(state.metrics), "info");
				return true;
			case "duration":
				if (parsed.durationMs === undefined) {
					notify(
						ctx,
						`cache-warm idle limit: ${formatDurationMs(state.activeMs)}`,
						"info",
					);
					return true;
				}
				setActiveMs(state, parsed.durationMs);
				await persistPreferencesForEdit(ctx, { activeMs: parsed.durationMs });
				syncStatus(ctx);
				notify(
					ctx,
					parsed.durationMs === 0
						? "cache-warm idle limit set to forever"
						: `cache-warm idle limit set to ${formatDurationMs(parsed.durationMs)}`,
					"info",
				);
				return true;
			case "rate":
				if (parsed.rateEnabled === undefined) {
					notify(
						ctx,
						`cache-warm rate limit: ${state.rateLimitEnabled ? "on" : "off"}`,
						"info",
					);
					return true;
				}
				setRateLimitEnabled(state, parsed.rateEnabled);
				await persistPreferencesForEdit(ctx, { rateLimitEnabled: parsed.rateEnabled });
				syncStatus(ctx);
				notify(
					ctx,
					parsed.rateEnabled ? "cache-warm rate limit enabled" : "cache-warm rate limit disabled",
					"info",
				);
				return true;
			default:
				notify(
					ctx,
					parsed.error ??
						"Usage: /cache-warm [on|off|status|metrics|duration [30m|1h|forever]|rate [on|off]]",
					"warning",
				);
				return false;
		}
	}

	async function openConfigPanel(ctx: ExtensionContext): Promise<void> {
		for (;;) {
			const rows = buildMenuRows(state);
			const choice = await ctx.ui.select("cache-warm", rows.map((row) => row.label));
			const row = rowForLabel(rows, choice);
			// Escape or an unrecognized label closes the panel without changing state.
			if (!row || row.key === "close") return;

			switch (row.key) {
				case "enabled":
					await applyCommand(parseCacheWarmArgs(state.enabled ? "off" : "on"), ctx, {
						confirmEnable: !state.enabled,
					});
					break;
				case "duration": {
					const duration = await ctx.ui.select(
						"cache-warm idle auto-stop",
						[...DURATION_OPTIONS],
					);
					if (duration === undefined) break;
					if (!DURATION_OPTIONS.includes(duration)) {
						notify(ctx, "Invalid cache-warm duration selection.", "warning");
						break;
					}
					const nextDuration = parseDurationMs(duration);
					if (state.enabled && state.activeMs !== 0 && nextDuration !== undefined &&
						(nextDuration === 0 || nextDuration > state.activeMs)) {
						const confirmed = await ctx.ui.confirm(
							"Increase billable warming window?",
							`Change idle auto-stop from ${formatDurationMs(state.activeMs)} to ${duration}. This may send more billable turns. Continue?`,
						);
						if (!confirmed) break;
					}
					await applyCommand(parseCacheWarmArgs(`duration ${duration}`), ctx);
					break;
				}
				case "rate": {
					const rate = await ctx.ui.select("cache-warm hourly rate limit", [...RATE_OPTIONS]);
					if (rate === undefined) break;
					if (!RATE_OPTIONS.includes(rate)) {
						notify(ctx, "Invalid cache-warm rate selection.", "warning");
						break;
					}
					if (state.enabled && state.rateLimitEnabled && state.maxPerHour > 0 && rate === "off") {
						const confirmed = await ctx.ui.confirm(
							"Remove hourly billable limit?",
							`Change from ${state.maxPerHour} warm turns per hour to no hourly cap. This may increase billed turns. Continue?`,
						);
						if (!confirmed) break;
					}
					await applyCommand(parseCacheWarmArgs(`rate ${rate}`), ctx);
					break;
				}
				case "status":
					await applyCommand(parseCacheWarmArgs("status"), ctx);
					break;
				case "metrics":
					await applyCommand(parseCacheWarmArgs("metrics"), ctx);
					break;
			}
		}
	}

	async function confirmEnable(ctx: ExtensionContext): Promise<boolean> {
		return ctx.ui.confirm(
			"Enable billable cache-warm?",
			`Idle auto-stop: ${formatDurationMs(state.activeMs)}; hourly rate limit: ${formatRateCap(state)}. Keep-alive sends billable prompts into the LLM context, and replies may become visible. Continue?`,
		);
	}

	function applyStartupFlags(warmState: ReturnType<typeof createWarmState>, api: ExtensionAPI): void {
		const durationFlag = flagValue(api, "cache-warm-duration");
		if (typeof durationFlag === "string") {
			const durationMs = parseDurationMs(durationFlag);
			if (durationMs !== undefined) setActiveMs(warmState, durationMs);
		}

		const rateFlag = flagValue(api, "cache-warm-rate") ?? flagValue(api, "cache-warm-rate-limit");
		if (typeof rateFlag === "string") {
			const rateEnabled = parseRateLimitFlag(rateFlag);
			if (rateEnabled !== undefined) setRateLimitEnabled(warmState, rateEnabled);
		}

		const enabledFlag = flagValue(api, "cache-warm-enabled");
		if (typeof enabledFlag === "boolean") {
			setEnabled(warmState, enabledFlag, enabledFlag ? Date.now() : undefined);
		} else {
			// Keep billable warming opt-in even if a host reuses this extension instance.
			setEnabled(warmState, false);
		}
	}

	async function persistPreferencesForEdit(ctx: ExtensionContext, patch: CacheWarmPreferencesPatch): Promise<void> {
		if (await savePreferencesPatch(patch)) return;
		notify(ctx, "Could not save cache-warm preferences; this change applies to the current session only.", "warning");
	}

	function enable(ctx: ExtensionContext): void {
		setEnabled(state, true, Date.now());
		mountedCtx = ctx;
		startTimer();
		syncStatus(ctx);
	}

	function disable(ctx: ExtensionContext): void {
		if (setEnabled(state, false)) ctx.abort();
		stopTimer();
		syncStatus(ctx);
	}

	function startTimer(): void {
		if (timer) return;
		timer = setInterval(() => {
			if (mountedCtx) tick(mountedCtx);
		}, TICK_MS);
		timer.unref?.();
	}

	function stopTimer(): void {
		if (!timer) return;
		clearInterval(timer);
		timer = undefined;
	}

	function tick(ctx: ExtensionContext): void {
		const now = Date.now();
		expirePendingDispatch(state, now);
		if (
			state.enabled &&
			!isActiveWindowOpen(now, state.activeMs, state.lastUserActivityAt)
		) {
			disable(ctx);
			notify(
				ctx,
				`cache-warm stopped after ${formatDurationMs(state.activeMs)} idle`,
				"info",
			);
			return;
		}
		if (
			shouldSendWarmPing({
				enabled: state.enabled,
				now,
				cacheLastActive: state.cacheLastActive,
				cacheEpoch: state.cacheEpoch,
				dispatchPending: state.dispatchPending !== undefined,
				warmRunActive: state.warmRunActive !== undefined,
				suppressedEpoch: state.suppressedEpoch,
				activeMs: state.activeMs,
				lastUserActivityAt: state.lastUserActivityAt,
				idle: ctx.isIdle(),
				hasPendingMessages: ctx.hasPendingMessages(),
				ttlMs: state.retention?.ttlMs,
				pingSentAt: state.pingSentAt,
				maxPerHour: state.maxPerHour,
				rateLimitEnabled: state.rateLimitEnabled,
			})
		) {
			const dispatch = beginWarmDispatch(state, now, ctx.model as Model<any> | undefined);
			if (dispatch) {
				try {
					pi.sendMessage(
						{
							customType: ENTRY_TYPE,
							content: buildPingContent(now, dispatch.id),
							display: false,
							details: { [DISPATCH_ID_KEY]: dispatch.id },
						},
						{ triggerTurn: true },
					);
				} catch {
					failPendingDispatch(state);
				}
			}
		}
		syncStatus(ctx);
	}

	function syncStatus(ctx?: ExtensionContext): void {
		const target = ctx ?? mountedCtx;
		if (target?.hasUI) target.ui.setStatus(STATUS_KEY, formatWarmFooter(state, Date.now()));
	}

	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	}
}

function flagValue(api: ExtensionAPI, name: string): boolean | string | undefined {
	return typeof api.getFlag === "function" ? api.getFlag(name) : undefined;
}

function parseRateLimitFlag(value: string): boolean | undefined {
	switch (value.trim().toLowerCase()) {
		case "on":
		case "true":
		case "enable":
		case "enabled":
		case "1":
			return true;
		case "off":
		case "false":
		case "disable":
		case "disabled":
		case "0":
			return false;
		default:
			return undefined;
	}
}
