import { CACHE_TTL_MS, CACHE_WARN_MS, computeCacheStatus, formatCountdown } from "./cache.js";
import {
	createMetrics,
	estimateGrossDiscountUsd,
	estimateTurnUsd,
	formatMetrics,
	formatUsd,
	hasCacheActivity,
	netUsdSaved,
	normalizeUsage,
	type Metrics,
	type ModelRates,
	type TokenUsage,
} from "./metrics.js";

/** Custom message type injected for keep-alive pings. */
export const ENTRY_TYPE = "cache-warm";

/** Tiny constant prompt. The assistant reply still enters LLM context. */
export const PING_CONTENT = 'Reply "." only. Do not use tools.';

/** Sorts before timestamp-pi's "cache-timestamp-pi" status key. */
export const STATUS_KEY = "cache-alive-warm";

/** Bound retries after a failed or unanswered ping. */
export const MIN_WARM_INTERVAL_MS = 15_000;

/** Drop in-flight attribution if the warm assistant never arrives. */
export const WARM_TIMEOUT_MS = 60_000;

export interface PendingTurn {
	startedAt: number;
	isWarmOrigin: boolean;
	assistantCount: number;
}

export interface WarmState {
	enabled: boolean;
	cacheLastActive: number | undefined;
	inFlight: boolean;
	lastAttemptAt: number | undefined;
	/** Snapshot of cacheLastActive when the current warm chain started. */
	lastActiveBeforeWarm: number | undefined;
	chainOpen: boolean;
	/** True after a completed warm turn observed cache activity. */
	chainEligible: boolean;
	chainAttributed: boolean;
	pendingTurn: PendingTurn | undefined;
	modelKey: string | undefined;
	metrics: Metrics;
}

export interface WarmPingGate {
	enabled: boolean;
	now: number;
	cacheLastActive: number | undefined;
	inFlight: boolean;
	idle: boolean;
	hasPendingMessages: boolean;
	lastAttemptAt?: number;
	ttlMs?: number;
	warnMs?: number;
	minIntervalMs?: number;
}

export function createWarmState(): WarmState {
	return {
		enabled: false,
		cacheLastActive: undefined,
		inFlight: false,
		lastAttemptAt: undefined,
		lastActiveBeforeWarm: undefined,
		chainOpen: false,
		chainEligible: false,
		chainAttributed: false,
		pendingTurn: undefined,
		modelKey: undefined,
		metrics: createMetrics(),
	};
}

/**
 * Gate for sending a keep-alive ping. Callers must recheck idle/pending
 * immediately before send.
 */
export function shouldSendWarmPing(gate: WarmPingGate): boolean {
	if (!gate.enabled) return false;
	if (gate.inFlight) return false;
	if (!gate.idle) return false;
	if (gate.hasPendingMessages) return false;
	if (gate.cacheLastActive === undefined) return false;
	const minInterval = gate.minIntervalMs ?? MIN_WARM_INTERVAL_MS;
	if (gate.lastAttemptAt !== undefined && gate.now - gate.lastAttemptAt < minInterval) {
		return false;
	}
	const status = computeCacheStatus(gate.cacheLastActive, gate.now, gate.ttlMs ?? CACHE_TTL_MS);
	if (status.state !== "active") return false;
	return status.remainingMs <= (gate.warnMs ?? CACHE_WARN_MS);
}

export function expireStaleInFlight(state: WarmState, now: number): void {
	if (!state.inFlight || state.lastAttemptAt === undefined) return;
	if (now - state.lastAttemptAt < WARM_TIMEOUT_MS) return;
	state.inFlight = false;
}

export function closeChain(state: WarmState): void {
	state.chainOpen = false;
	state.chainEligible = false;
	state.chainAttributed = false;
	state.lastActiveBeforeWarm = undefined;
}

export function beginWarmPing(state: WarmState, now: number): void {
	state.metrics.warmAttempts += 1;
	state.inFlight = true;
	state.lastAttemptAt = now;
	if (!state.chainOpen) {
		state.chainOpen = true;
		state.lastActiveBeforeWarm = state.cacheLastActive;
		state.chainEligible = false;
		state.chainAttributed = false;
	}
}

export function noteTurnStart(state: WarmState, startedAt: number): void {
	expireStaleInFlight(state, startedAt);
	state.pendingTurn = {
		startedAt,
		isWarmOrigin: state.inFlight,
		assistantCount: 0,
	};
}

export function noteTurnEnd(state: WarmState): void {
	state.pendingTurn = undefined;
}

/**
 * User or other-custom traffic while a warm ping is in flight cancels refresh
 * and avoided-miss attribution. Warm spend is still charged if the assistant
 * reply is later identified as warm-origin.
 */
export function noteInterveningTurn(state: WarmState): void {
	const racing =
		state.inFlight ||
		(state.pendingTurn?.isWarmOrigin === true && state.pendingTurn.assistantCount === 0);
	if (!racing) return;
	state.inFlight = false;
	closeChain(state);
}

export function applyAssistantUsage(
	state: WarmState,
	input: {
		now: number;
		usage?: Partial<TokenUsage> | null;
		model?: ModelRates | unknown;
		startedAt?: number;
	},
): void {
	const usage = normalizeUsage(input.usage);
	if (!state.pendingTurn) {
		state.pendingTurn = {
			startedAt: input.startedAt ?? input.now,
			isWarmOrigin: state.inFlight,
			assistantCount: 0,
		};
	} else if (input.startedAt !== undefined && state.pendingTurn.assistantCount === 0) {
		state.pendingTurn.startedAt = input.startedAt;
	}

	const pending = state.pendingTurn;
	const isFirst = pending.assistantCount === 0;
	if (hasCacheActivity(usage)) {
		state.cacheLastActive = input.now;
	}

	if (pending.isWarmOrigin) {
		addWarmSpend(state, input.model, usage);
		if (isFirst) {
			const refreshAttributed = state.inFlight && usage.cacheRead > 0;
			if (refreshAttributed) {
				state.metrics.warmRefreshes += 1;
			}
			if (state.inFlight && hasCacheActivity(usage)) {
				state.chainEligible = true;
			}
			state.inFlight = false;
		}
	} else if (isFirst) {
		adjudicateNonWarmTurn(state, pending.startedAt, usage, input.model);
	}

	pending.assistantCount += 1;
}

export function applyModelChange(state: WarmState, nextKey: string | undefined): void {
	if (nextKey === state.modelKey) return;
	state.modelKey = nextKey;
	state.cacheLastActive = undefined;
	state.inFlight = false;
	state.lastAttemptAt = undefined;
	state.pendingTurn = undefined;
	closeChain(state);
}

export function setEnabled(state: WarmState, enabled: boolean): void {
	state.enabled = enabled;
	if (enabled) return;
	state.inFlight = false;
	state.pendingTurn = undefined;
	closeChain(state);
}

export function resetSession(state: WarmState): void {
	state.enabled = false;
	state.cacheLastActive = undefined;
	state.inFlight = false;
	state.lastAttemptAt = undefined;
	state.pendingTurn = undefined;
	state.modelKey = undefined;
	closeChain(state);
	state.metrics = createMetrics();
}

export function modelKeyOf(model: { id?: unknown; provider?: unknown } | undefined): string | undefined {
	if (!model) return undefined;
	const provider = typeof model.provider === "string" ? model.provider : "";
	const id = typeof model.id === "string" ? model.id : "";
	if (!provider && !id) return undefined;
	return `${provider}/${id}`;
}

export function formatWarmFooter(state: WarmState, now: number): string | undefined {
	if (!state.enabled) return undefined;
	const status = computeCacheStatus(state.cacheLastActive, now);
	const hits = state.metrics.likelyAvoidedMisses;
	const saved = formatUsd(netUsdSaved(state.metrics));
	const tail = `${hits} hit${hits === 1 ? "" : "s"} · ${saved}`;
	if (status.state === "idle") return `warm on · ${tail}`;
	if (status.state === "expired") return `warm expired · ${tail}`;
	return `warm ${formatCountdown(status.remainingMs)} · ${tail}`;
}

export function formatStatusReport(state: WarmState, now: number): string {
	const status = computeCacheStatus(state.cacheLastActive, now);
	const cacheLine =
		status.state === "idle"
			? "cache: idle (no activity yet)"
			: status.state === "expired"
				? "cache: expired"
				: `cache: ${formatCountdown(status.remainingMs)} remaining`;
	return [`cache-warm: ${state.enabled ? "on" : "off"}`, cacheLine, formatMetrics(state.metrics)].join("\n");
}

function adjudicateNonWarmTurn(
	state: WarmState,
	startedAt: number,
	usage: TokenUsage,
	model: unknown,
): void {
	if (
		state.chainEligible &&
		!state.chainAttributed &&
		state.lastActiveBeforeWarm !== undefined &&
		startedAt > state.lastActiveBeforeWarm + CACHE_TTL_MS &&
		usage.cacheRead > 0
	) {
		state.metrics.likelyAvoidedMisses += 1;
		state.chainAttributed = true;
		const discount = estimateGrossDiscountUsd(model, usage.cacheRead);
		if (discount === null) {
			state.metrics.pricingKnown = false;
		} else {
			state.metrics.grossDiscountUsd += discount;
		}
	}
	closeChain(state);
}

function addWarmSpend(state: WarmState, model: unknown, usage: TokenUsage): void {
	const spend = estimateTurnUsd(model, usage);
	if (spend === null) {
		state.metrics.pricingKnown = false;
		return;
	}
	state.metrics.warmSpendUsd += spend;
}
