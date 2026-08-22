import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { parseCacheWarmArgs } from "./command.js";
import { formatMetrics } from "./metrics.js";
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
	markWarmAbortCalled,
	modelKeyOf,
	noteAgentSettled,
	noteAgentStart,
	noteExternalInput,
	noteTurnStart,
	PING_CONTENT,
	resetSession,
	setEnabled,
	shouldSendWarmPing,
	STATUS_KEY,
} from "./warm.js";

export { CACHE_TTL_MS, CACHE_WARN_MS, computeCacheStatus, formatCountdown } from "./cache.js";
export { parseCacheWarmArgs } from "./command.js";
export type { CacheWarmAction } from "./command.js";
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
	formatStatusReport,
	formatWarmFooter,
	markWarmAbortCalled,
	modelKeyOf,
	noteAgentSettled,
	noteAgentStart,
	noteExternalInput,
	noteTurnStart,
	PING_CONTENT,
	resetSession,
	setEnabled,
	shouldSendWarmPing,
	STATUS_KEY,
	WARM_TIMEOUT_MS,
} from "./warm.js";
export type { PendingTurn, WarmDispatch, WarmPingGate, WarmRun, WarmState } from "./warm.js";

const TICK_MS = 1_000;
const TOOL_BLOCK_REASON = "cache-warm hidden turns cannot call tools";
const DISPATCH_ID_KEY = "cacheWarmDispatchId";

export default function cacheWarmExtension(pi: ExtensionAPI) {
	const state = createWarmState();
	let timer: ReturnType<typeof setInterval> | undefined;
	let mountedCtx: ExtensionContext | undefined;

	pi.on("session_start", async (_event, ctx) => {
		mountedCtx = ctx;
		applyModelChange(state, modelKeyOf(ctx.model));
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
			if (noteExternalInput(state)) ctx.abort();
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
			const action = parseCacheWarmArgs(args);
			switch (action) {
				case "on":
				enable(ctx);
				notify(ctx, "cache-warm enabled", "info");
				return;
				case "off":
				disable(ctx);
				notify(ctx, "cache-warm disabled", "info");
				return;
				case "toggle":
				if (state.enabled) {
					disable(ctx);
					notify(ctx, "cache-warm disabled", "info");
				} else {
					enable(ctx);
					notify(ctx, "cache-warm enabled", "info");
				}
				return;
				case "status":
				notify(ctx, formatStatusReport(state, Date.now()), "info");
				return;
				case "metrics":
				notify(ctx, formatMetrics(state.metrics), "info");
				return;
				default:
				notify(ctx, "Usage: /cache-warm [on|off|status|metrics]", "warning");
			}
		},
	});

	function enable(ctx: ExtensionContext): void {
		setEnabled(state, true);
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
	}

	function stopTimer(): void {
		if (!timer) return;
		clearInterval(timer);
		timer = undefined;
	}

	function tick(ctx: ExtensionContext): void {
		const now = Date.now();
		expirePendingDispatch(state, now);
		const idle = ctx.isIdle();
		const hasPendingMessages = ctx.hasPendingMessages();
		if (
			shouldSendWarmPing({
				enabled: state.enabled,
				now,
				cacheLastActive: state.cacheLastActive,
				cacheEpoch: state.cacheEpoch,
				dispatchPending: state.dispatchPending !== undefined,
				warmRunActive: state.warmRunActive !== undefined,
				suppressedEpoch: state.suppressedEpoch,
				idle,
				hasPendingMessages,
			}) &&
			ctx.isIdle() &&
			!ctx.hasPendingMessages() &&
			state.enabled &&
			!state.dispatchPending &&
			!state.warmRunActive
		) {
			const dispatch = beginWarmDispatch(state, now, ctx.model as Model<any> | undefined);
			if (dispatch) {
				try {
					pi.sendMessage(
						{
							customType: ENTRY_TYPE,
							content: PING_CONTENT,
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
