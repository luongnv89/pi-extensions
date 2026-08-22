import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseCacheWarmArgs } from "./command.js";
import { formatMetrics } from "./metrics.js";
import {
	applyAssistantUsage,
	applyModelChange,
	beginWarmPing,
	createWarmState,
	ENTRY_TYPE,
	expireStaleInFlight,
	formatStatusReport,
	formatWarmFooter,
	modelKeyOf,
	noteInterveningTurn,
	noteTurnEnd,
	noteTurnStart,
	PING_CONTENT,
	resetSession,
	setEnabled,
	shouldSendWarmPing,
	STATUS_KEY,
} from "./warm.js";

export {
	CACHE_TTL_MS,
	CACHE_WARN_MS,
	computeCacheStatus,
	formatCountdown,
} from "./cache.js";
export { parseCacheWarmArgs } from "./command.js";
export type { CacheWarmAction } from "./command.js";
export {
	calculateCostFromModelRates,
	createMetrics,
	estimateGrossDiscountUsd,
	estimateTurnUsd,
	formatMetrics,
	formatUsd,
	hasValidRates,
	netUsdSaved,
	normalizeUsage,
} from "./metrics.js";
export type { Metrics, ModelRates, TokenUsage } from "./metrics.js";
export {
	applyAssistantUsage,
	applyModelChange,
	beginWarmPing,
	closeChain,
	createWarmState,
	ENTRY_TYPE,
	expireStaleInFlight,
	formatStatusReport,
	formatWarmFooter,
	MIN_WARM_INTERVAL_MS,
	modelKeyOf,
	noteInterveningTurn,
	noteTurnEnd,
	noteTurnStart,
	PING_CONTENT,
	resetSession,
	setEnabled,
	shouldSendWarmPing,
	STATUS_KEY,
	WARM_TIMEOUT_MS,
} from "./warm.js";
export type { PendingTurn, WarmPingGate, WarmState } from "./warm.js";

const TICK_MS = 1_000;

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
		if (mountedCtx?.hasUI) {
			mountedCtx.ui.setStatus(STATUS_KEY, undefined);
		}
		mountedCtx = undefined;
	});

	pi.on("model_select", async (event, ctx) => {
		applyModelChange(state, modelKeyOf(event.model ?? ctx.model));
		syncStatus(ctx);
	});

	pi.on("turn_start", async (event) => {
		noteTurnStart(state, event.timestamp ?? Date.now());
	});

	pi.on("turn_end", async () => {
		noteTurnEnd(state);
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message as {
			role?: string;
			customType?: string;
			usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
		};

		if (message.role === "user") {
			noteInterveningTurn(state);
			return;
		}

		if (message.role === "custom") {
			if (message.customType !== ENTRY_TYPE) {
				noteInterveningTurn(state);
			}
			return;
		}

		if (message.role !== "assistant") return;

		applyAssistantUsage(state, {
			now: Date.now(),
			usage: message.usage,
			model: ctx.model,
		});
		syncStatus(ctx);
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
		setEnabled(state, false);
		stopTimer();
		syncStatus(ctx);
	}

	function startTimer(): void {
		if (timer) return;
		timer = setInterval(() => {
			const ctx = mountedCtx;
			if (!ctx) return;
			tick(ctx);
		}, TICK_MS);
	}

	function stopTimer(): void {
		if (!timer) return;
		clearInterval(timer);
		timer = undefined;
	}

	function tick(ctx: ExtensionContext): void {
		const now = Date.now();
		expireStaleInFlight(state, now);
		const idle = ctx.isIdle();
		const pending = ctx.hasPendingMessages();
		if (
			shouldSendWarmPing({
				enabled: state.enabled,
				now,
				cacheLastActive: state.cacheLastActive,
				inFlight: state.inFlight,
				idle,
				hasPendingMessages: pending,
				lastAttemptAt: state.lastAttemptAt,
			}) &&
			ctx.isIdle() &&
			!ctx.hasPendingMessages()
		) {
			beginWarmPing(state, now);
			try {
				pi.sendMessage(
					{
						customType: ENTRY_TYPE,
						content: PING_CONTENT,
						display: false,
					},
					{ triggerTurn: true },
				);
			} catch {
				state.inFlight = false;
			}
		}
		syncStatus(ctx);
	}

	function syncStatus(ctx?: ExtensionContext): void {
		const target = ctx ?? mountedCtx;
		if (!target?.hasUI) return;
		target.ui.setStatus(STATUS_KEY, formatWarmFooter(state, Date.now()));
	}

	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
		if (!ctx.hasUI) return;
		ctx.ui.notify(message, level);
	}
}
