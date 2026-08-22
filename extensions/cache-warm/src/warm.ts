import type { Model, Usage } from "@earendil-works/pi-ai";
import { CACHE_TTL_MS, CACHE_WARN_MS, computeCacheStatus, formatCountdown } from "./cache.js";
import {
	createMetrics,
	estimateGrossBenefitUsd,
	estimateTurnUsd,
	formatMetrics,
	formatUsd,
	hasCacheActivity,
	inferMissBillingMode,
	netUsdSaved,
	normalizeUsage,
	type Metrics,
	type MissBillingMode,
} from "./metrics.js";

export const ENTRY_TYPE = "cache-warm";
export const PING_CONTENT = 'Reply "." only. Do not use tools.';
export const STATUS_KEY = "cache-alive-warm";
export const WARM_TIMEOUT_MS = 60_000;

export interface WarmDispatch {
	id: string;
	requestedAt: number;
	cacheEpoch: number;
	cacheLastActive: number;
	modelKey: string | undefined;
	model: Model<any> | undefined;
}

export interface WarmRun {
	dispatch: WarmDispatch;
	interrupted: boolean;
	abortCalled: boolean;
	refreshCounted: boolean;
	eligible: boolean;
}

export interface PendingTurn {
	startedAt: number;
	origin: "warm" | "external" | "unknown";
	assistantCount: number;
}

interface ExternalRun {
	firstStartedAt: number | undefined;
	adjudicated: boolean;
}

interface WarmChain {
	counterfactualExpiry: number;
	confirmedRefresh: boolean;
	attributed: boolean;
	missMode: MissBillingMode | null;
}

export interface WarmState {
	enabled: boolean;
	cacheLastActive: number | undefined;
	cacheEpoch: number;
	suppressedEpoch: number | undefined;
	dispatchPending: WarmDispatch | undefined;
	staleDispatches: Map<string, WarmDispatch>;
	warmRunActive: WarmRun | undefined;
	lastAttemptAt: number | undefined;
	pendingTurn: PendingTurn | undefined;
	externalRun: ExternalRun | undefined;
	chain: WarmChain | undefined;
	observedMissMode: MissBillingMode | null;
	modelKey: string | undefined;
	metrics: Metrics;
	dispatchSequence: number;
}

export interface WarmPingGate {
	enabled: boolean;
	now: number;
	cacheLastActive: number | undefined;
	cacheEpoch: number;
	dispatchPending: boolean;
	warmRunActive: boolean;
	suppressedEpoch?: number;
	idle: boolean;
	hasPendingMessages: boolean;
	ttlMs?: number;
	warnMs?: number;
}

export function createWarmState(): WarmState {
	return {
		enabled: false,
		cacheLastActive: undefined,
		cacheEpoch: 0,
		suppressedEpoch: undefined,
		dispatchPending: undefined,
		staleDispatches: new Map(),
		warmRunActive: undefined,
		lastAttemptAt: undefined,
		pendingTurn: undefined,
		externalRun: undefined,
		chain: undefined,
		observedMissMode: null,
		modelKey: undefined,
		metrics: createMetrics(),
		dispatchSequence: 0,
	};
}

export function shouldSendWarmPing(gate: WarmPingGate): boolean {
	if (!gate.enabled || gate.dispatchPending || gate.warmRunActive) return false;
	if (!gate.idle || gate.hasPendingMessages || gate.cacheLastActive === undefined) return false;
	if (gate.suppressedEpoch === gate.cacheEpoch) return false;
	const status = computeCacheStatus(gate.cacheLastActive, gate.now, gate.ttlMs ?? CACHE_TTL_MS);
	return status.state === "active" && status.remainingMs <= (gate.warnMs ?? CACHE_WARN_MS);
}

export function beginWarmDispatch(
	state: WarmState,
	now: number,
	model: Model<any> | undefined,
): WarmDispatch | undefined {
	if (state.cacheLastActive === undefined || state.dispatchPending || state.warmRunActive) return undefined;
	const dispatch: WarmDispatch = {
		id: `${now.toString(36)}-${(++state.dispatchSequence).toString(36)}`,
		requestedAt: now,
		cacheEpoch: state.cacheEpoch,
		cacheLastActive: state.cacheLastActive,
		modelKey: modelKeyOf(model),
		model,
	};
	state.dispatchPending = dispatch;
	state.lastAttemptAt = now;
	return dispatch;
}

/** Suppress this cache epoch; a late dispatch remains recognizable and cannot be retried. */
export function expirePendingDispatch(state: WarmState, now: number): boolean {
	const pending = state.dispatchPending;
	if (!pending || now - pending.requestedAt < WARM_TIMEOUT_MS) return false;
	quarantinePending(state);
	return true;
}

export function failPendingDispatch(state: WarmState): void {
	if (state.dispatchPending) quarantinePending(state);
}

export function confirmWarmDispatch(state: WarmState, id: string): { confirmed: boolean; abort: boolean } {
	let dispatch: WarmDispatch | undefined;
	let eligible = false;
	if (state.dispatchPending?.id === id) {
		dispatch = state.dispatchPending;
		state.dispatchPending = undefined;
		eligible =
			state.enabled &&
			dispatch.cacheEpoch === state.cacheEpoch &&
			dispatch.modelKey === state.modelKey;
	} else {
		dispatch = state.staleDispatches.get(id);
		if (dispatch) state.staleDispatches.delete(id);
	}
	if (!dispatch) return { confirmed: false, abort: false };
	state.metrics.warmAttempts += 1;
	state.externalRun = undefined;
	if (state.warmRunActive) {
		state.warmRunActive.interrupted = true;
		state.warmRunActive.eligible = false;
		if (state.pendingTurn) state.pendingTurn.origin = "warm";
		closeChain(state);
		return { confirmed: true, abort: true };
	}
	state.warmRunActive = {
		dispatch,
		interrupted: !eligible,
		abortCalled: false,
		refreshCounted: false,
		eligible,
	};
	if (state.pendingTurn) state.pendingTurn.origin = "warm";
	if (eligible && !state.chain) {
		state.chain = {
			counterfactualExpiry: dispatch.cacheLastActive + CACHE_TTL_MS,
			confirmedRefresh: false,
			attributed: false,
			missMode: state.observedMissMode,
		};
	}
	return { confirmed: true, abort: !eligible };
}

export function noteAgentStart(state: WarmState): void {
	if (state.warmRunActive || state.dispatchPending) return;
	state.externalRun ??= { firstStartedAt: undefined, adjudicated: false };
}

export function noteTurnStart(state: WarmState, startedAt: number): void {
	const origin = state.warmRunActive ? "warm" : state.dispatchPending ? "unknown" : "external";
	state.pendingTurn = { startedAt, origin, assistantCount: 0 };
	if (origin === "external") {
		state.externalRun ??= { firstStartedAt: startedAt, adjudicated: false };
		state.externalRun.firstStartedAt ??= startedAt;
	}
}

export function noteExternalInput(state: WarmState): boolean {
	if (state.dispatchPending) {
		quarantinePending(state);
		closeChain(state);
	}
	if (state.warmRunActive) {
		closeChain(state);
		state.warmRunActive.interrupted = true;
		state.warmRunActive.eligible = false;
		if (!state.warmRunActive.abortCalled) {
			state.warmRunActive.abortCalled = true;
			return true;
		}
		return false;
	}
	state.externalRun ??= { firstStartedAt: state.pendingTurn?.startedAt, adjudicated: false };
	if (state.pendingTurn) {
		state.pendingTurn.origin = "external";
		state.externalRun.firstStartedAt ??= state.pendingTurn.startedAt;
	}
	return false;
}

export function markWarmAbortCalled(state: WarmState): boolean {
	const run = state.warmRunActive;
	if (!run || run.abortCalled) return false;
	run.abortCalled = true;
	return true;
}

export function applyAssistantUsage(
	state: WarmState,
	input: { usage?: Partial<Usage> | null; model?: Model<any>; startedAt?: number },
): void {
	const rawUsage = input.usage;
	const usage = normalizeUsage(rawUsage);
	const observedMode = inferMissBillingMode(input.model, usage);
	if (observedMode === "cacheWrite1h" || state.observedMissMode === null) {
		state.observedMissMode = observedMode;
	}
	if (!state.pendingTurn && input.startedAt !== undefined) {
		state.pendingTurn = {
			startedAt: input.startedAt,
			origin: state.warmRunActive ? "warm" : "external",
			assistantCount: 0,
		};
	}
	const turn = state.pendingTurn;
	if (turn && hasCacheActivity(usage)) noteCacheActivity(state, turn.startedAt);

	const run = state.warmRunActive;
	if (run) {
		addWarmSpend(state, run.dispatch.model ?? input.model, rawUsage ?? usage);
		if (!run.refreshCounted && hasCacheActivity(usage)) {
			run.refreshCounted = true;
			state.metrics.warmRefreshes += 1;
		}
		if (run.eligible && !run.interrupted && hasCacheActivity(usage) && state.chain) {
			state.chain.confirmedRefresh = true;
			const mode = inferMissBillingMode(run.dispatch.model ?? input.model, usage);
			if (mode === "cacheWrite1h" || state.chain.missMode === null) state.chain.missMode = mode;
		}
	} else if (turn && turn.origin === "external" && state.externalRun && !state.externalRun.adjudicated) {
		state.externalRun.adjudicated = adjudicateExternalRun(
			state,
			state.externalRun.firstStartedAt ?? turn.startedAt,
			usage,
			input.model,
		);
	}
	if (turn) turn.assistantCount += 1;
}

export function noteAgentSettled(state: WarmState): void {
	if (!state.warmRunActive && state.externalRun) closeChain(state);
	state.warmRunActive = undefined;
	state.pendingTurn = undefined;
	state.externalRun = undefined;
}

export function applyModelChange(state: WarmState, nextKey: string | undefined): boolean {
	if (nextKey === state.modelKey) return false;
	state.modelKey = nextKey;
	if (state.dispatchPending) quarantinePending(state);
	closeChain(state);
	state.cacheLastActive = undefined;
	state.cacheEpoch += 1;
	state.suppressedEpoch = undefined;
	state.observedMissMode = null;
	state.pendingTurn = undefined;
	state.externalRun = undefined;
	if (!state.warmRunActive) return false;
	state.warmRunActive.interrupted = true;
	state.warmRunActive.eligible = false;
	return markWarmAbortCalled(state);
}

export function setEnabled(state: WarmState, enabled: boolean): boolean {
	const wasEnabled = state.enabled;
	state.enabled = enabled;
	if (enabled) {
		if (!wasEnabled) state.suppressedEpoch = undefined;
		return false;
	}
	if (state.dispatchPending) quarantinePending(state);
	closeChain(state);
	state.externalRun = undefined;
	if (!state.warmRunActive) return false;
	state.warmRunActive.interrupted = true;
	state.warmRunActive.eligible = false;
	return markWarmAbortCalled(state);
}

export function resetSession(state: WarmState): void {
	state.enabled = false;
	state.cacheLastActive = undefined;
	state.cacheEpoch = 0;
	state.suppressedEpoch = undefined;
	state.dispatchPending = undefined;
	state.staleDispatches.clear();
	state.warmRunActive = undefined;
	state.lastAttemptAt = undefined;
	state.pendingTurn = undefined;
	state.externalRun = undefined;
	state.chain = undefined;
	state.observedMissMode = null;
	state.modelKey = undefined;
	state.metrics = createMetrics();
}

export function closeChain(state: WarmState): void {
	state.chain = undefined;
}

export function modelKeyOf(model: { id?: unknown; provider?: unknown } | undefined): string | undefined {
	if (!model) return undefined;
	const provider = typeof model.provider === "string" ? model.provider : "";
	const id = typeof model.id === "string" ? model.id : "";
	return provider || id ? `${provider}/${id}` : undefined;
}

export function formatWarmFooter(state: WarmState, now: number): string | undefined {
	if (!state.enabled) return undefined;
	const status = computeCacheStatus(state.cacheLastActive, now);
	const hits = state.metrics.likelyAvoidedMisses;
	const tail = `${hits} hit${hits === 1 ? "" : "s"} · ${formatUsd(netUsdSaved(state.metrics))}`;
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

function quarantinePending(state: WarmState): void {
	const pending = state.dispatchPending;
	if (!pending) return;
	state.dispatchPending = undefined;
	state.suppressedEpoch = pending.cacheEpoch;
	state.staleDispatches.set(pending.id, pending);
}

function noteCacheActivity(state: WarmState, startedAt: number): void {
	if (state.cacheLastActive !== undefined && startedAt <= state.cacheLastActive) return;
	state.cacheLastActive = startedAt;
	state.cacheEpoch += 1;
	if (state.suppressedEpoch !== undefined && state.suppressedEpoch !== state.cacheEpoch) {
		state.suppressedEpoch = undefined;
	}
}

function adjudicateExternalRun(
	state: WarmState,
	firstStartedAt: number,
	usage: Usage,
	model: Model<any> | undefined,
): boolean {
	const chain = state.chain;
	if (!chain || firstStartedAt <= chain.counterfactualExpiry) {
		closeChain(state);
		return true;
	}
	if (usage.cacheRead > 0) {
		if (chain.confirmedRefresh && !chain.attributed) {
			chain.attributed = true;
			state.metrics.likelyAvoidedMisses += 1;
			const gross = estimateGrossBenefitUsd(model, usage, chain.missMode);
			if (gross === null) state.metrics.pricingKnown = false;
			else state.metrics.grossDiscountUsd += gross;
		}
		closeChain(state);
		return true;
	}
	const hasBillingEvidence =
		usage.input > 0 ||
		usage.output > 0 ||
		usage.cacheWrite > 0 ||
		(usage.cacheWrite1h ?? 0) > 0 ||
		usage.totalTokens > 0;
	if (hasBillingEvidence) closeChain(state);
	return hasBillingEvidence;
}

function addWarmSpend(state: WarmState, model: Model<any> | undefined, usage: Partial<Usage>): void {
	const spend = estimateTurnUsd(model, usage);
	if (spend === null) state.metrics.pricingKnown = false;
	else state.metrics.warmSpendUsd += spend;
}
