import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	CACHE_TTL_MS,
	CACHE_WARN_MS,
	MIN_WARM_INTERVAL_MS,
	applyAssistantUsage,
	applyModelChange,
	beginWarmPing,
	computeCacheStatus,
	createWarmState,
	formatCountdown,
	formatMetrics,
	formatUsd,
	formatWarmFooter,
	noteInterveningTurn,
	noteTurnEnd,
	noteTurnStart,
	parseCacheWarmArgs,
	resetSession,
	setEnabled,
	shouldSendWarmPing,
} from "../dist/index.js";

const RATES = {
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

function usage(partial = {}) {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		...partial,
	};
}

function gate(overrides = {}) {
	return {
		enabled: true,
		now: 1_000_000,
		cacheLastActive: 1_000_000 - (CACHE_TTL_MS - 30_000),
		inFlight: false,
		idle: true,
		hasPendingMessages: false,
		...overrides,
	};
}

function seedCache(state, at) {
	applyAssistantUsage(state, {
		now: at,
		usage: usage({ cacheWrite: 200, input: 50 }),
		model: RATES,
	});
	state.pendingTurn = undefined;
}

describe("parseCacheWarmArgs", () => {
	it("toggles on empty input", () => {
		assert.equal(parseCacheWarmArgs(""), "toggle");
		assert.equal(parseCacheWarmArgs("   "), "toggle");
	});

	it("parses on/off/status/metrics", () => {
		assert.equal(parseCacheWarmArgs("on"), "on");
		assert.equal(parseCacheWarmArgs("  OFF "), "off");
		assert.equal(parseCacheWarmArgs("status"), "status");
		assert.equal(parseCacheWarmArgs("metrics extra"), "metrics");
	});

	it("accepts enable/disable aliases and rejects unknown args", () => {
		assert.equal(parseCacheWarmArgs("enable"), "on");
		assert.equal(parseCacheWarmArgs("disable"), "off");
		assert.equal(parseCacheWarmArgs("nope"), "unknown");
	});
});

describe("formatCountdown", () => {
	it("formats m:ss with padding", () => {
		assert.equal(formatCountdown(4 * 60_000 + 32_000), "4:32");
		assert.equal(formatCountdown(5_000), "0:05");
	});

	it("rounds up partial seconds and clamps at 0:00", () => {
		assert.equal(formatCountdown(500), "0:01");
		assert.equal(formatCountdown(-10_000), "0:00");
	});
});

describe("computeCacheStatus", () => {
	const now = Date.now();

	it("is idle without cache activity", () => {
		assert.deepEqual(computeCacheStatus(undefined, now), {
			state: "idle",
			label: "",
			remainingMs: 0,
		});
	});

	it("counts down while the cache is warm", () => {
		const status = computeCacheStatus(now - 28_000, now);
		assert.equal(status.state, "active");
		assert.equal(status.label, "cache 4:32");
		assert.equal(status.remainingMs, CACHE_TTL_MS - 28_000);
	});

	it("reports expired once the TTL elapses", () => {
		const status = computeCacheStatus(now - CACHE_TTL_MS - 1_000, now);
		assert.equal(status.state, "expired");
		assert.equal(status.label, "cache expired");
		assert.equal(status.remainingMs, 0);
	});

	it("honors a custom TTL", () => {
		const status = computeCacheStatus(now - 90_000, now, 2 * 60_000);
		assert.equal(status.state, "active");
		assert.equal(status.label, "cache 0:30");
	});
});

describe("shouldSendWarmPing", () => {
	it("is false when disabled even if TTL is about to expire", () => {
		assert.equal(shouldSendWarmPing(gate({ enabled: false })), false);
	});

	it("requires idle and no pending messages", () => {
		assert.equal(shouldSendWarmPing(gate({ idle: false })), false);
		assert.equal(shouldSendWarmPing(gate({ hasPendingMessages: true })), false);
	});

	it("blocks a second ping while one is in flight", () => {
		assert.equal(shouldSendWarmPing(gate({ inFlight: true })), false);
	});

	it("never pings before the first cache activity", () => {
		assert.equal(shouldSendWarmPing(gate({ cacheLastActive: undefined })), false);
	});

	it("pings only while remaining TTL is at or below the warn threshold", () => {
		const now = 5_000_000;
		assert.equal(
			shouldSendWarmPing(
				gate({
					now,
					cacheLastActive: now - (CACHE_TTL_MS - CACHE_WARN_MS - 1_000),
				}),
			),
			false,
		);
		assert.equal(
			shouldSendWarmPing(
				gate({
					now,
					cacheLastActive: now - (CACHE_TTL_MS - CACHE_WARN_MS),
				}),
			),
			true,
		);
		assert.equal(
			shouldSendWarmPing(
				gate({
					now,
					cacheLastActive: now - (CACHE_TTL_MS - 1_000),
				}),
			),
			true,
		);
	});

	it("does not ping after the cache has expired", () => {
		const now = 5_000_000;
		assert.equal(
			shouldSendWarmPing(
				gate({
					now,
					cacheLastActive: now - CACHE_TTL_MS,
				}),
			),
			false,
		);
	});

	it("bounds retries with a minimum interval after the last attempt", () => {
		const now = 5_000_000;
		assert.equal(
			shouldSendWarmPing(
				gate({
					now,
					cacheLastActive: now - (CACHE_TTL_MS - 10_000),
					lastAttemptAt: now - MIN_WARM_INTERVAL_MS + 1,
				}),
			),
			false,
		);
		assert.equal(
			shouldSendWarmPing(
				gate({
					now,
					cacheLastActive: now - (CACHE_TTL_MS - 10_000),
					lastAttemptAt: now - MIN_WARM_INTERVAL_MS,
				}),
			),
			true,
		);
	});
});

describe("savings attribution", () => {
	it("does not count a normal-user cacheRead as an avoided miss", () => {
		const state = createWarmState();
		const t0 = 0;
		seedCache(state, t0);
		noteTurnStart(state, t0 + 30_000);
		applyAssistantUsage(state, {
			now: t0 + 31_000,
			usage: usage({ cacheRead: 8_000, input: 100, output: 50 }),
			model: RATES,
		});
		assert.equal(state.metrics.likelyAvoidedMisses, 0);
		assert.equal(state.metrics.warmRefreshes, 0);
		assert.equal(state.metrics.warmAttempts, 0);
	});

	it("counts a warm ping cacheRead as a refresh, not an avoided miss", () => {
		const state = createWarmState();
		const t0 = 0;
		seedCache(state, t0);
		beginWarmPing(state, t0 + CACHE_TTL_MS - 30_000);
		noteTurnStart(state, t0 + CACHE_TTL_MS - 29_000);
		applyAssistantUsage(state, {
			now: t0 + CACHE_TTL_MS - 28_000,
			usage: usage({ cacheRead: 4_000, input: 20, output: 1 }),
			model: RATES,
		});
		assert.equal(state.metrics.warmAttempts, 1);
		assert.equal(state.metrics.warmRefreshes, 1);
		assert.equal(state.metrics.likelyAvoidedMisses, 0);
	});

	it("attributes likelyAvoidedMisses once per chain after counterfactual expiry", () => {
		const state = createWarmState();
		const t0 = 1_000_000;
		seedCache(state, t0);

		beginWarmPing(state, t0 + CACHE_TTL_MS - 40_000);
		noteTurnStart(state, t0 + CACHE_TTL_MS - 39_000);
		applyAssistantUsage(state, {
			now: t0 + CACHE_TTL_MS - 38_000,
			usage: usage({ cacheRead: 2_000, input: 10, output: 1 }),
			model: RATES,
		});

		beginWarmPing(state, t0 + CACHE_TTL_MS + 200_000);
		noteTurnStart(state, t0 + CACHE_TTL_MS + 201_000);
		applyAssistantUsage(state, {
			now: t0 + CACHE_TTL_MS + 202_000,
			usage: usage({ cacheRead: 2_000, input: 10, output: 1 }),
			model: RATES,
		});

		const userStart = t0 + CACHE_TTL_MS + 250_000;
		noteTurnStart(state, userStart);
		applyAssistantUsage(state, {
			now: userStart + 5_000,
			usage: usage({ cacheRead: 50_000, input: 200, output: 80 }),
			model: RATES,
		});
		assert.equal(state.metrics.likelyAvoidedMisses, 1);
		assert.equal(state.metrics.warmRefreshes, 2);

		noteTurnStart(state, userStart + 60_000);
		applyAssistantUsage(state, {
			now: userStart + 61_000,
			usage: usage({ cacheRead: 40_000, input: 100, output: 20 }),
			model: RATES,
		});
		assert.equal(state.metrics.likelyAvoidedMisses, 1);
	});

	it("does not count a turn that started before expiry even if it finished after", () => {
		const state = createWarmState();
		const t0 = 0;
		seedCache(state, t0);
		beginWarmPing(state, t0 + CACHE_TTL_MS - 20_000);
		noteTurnStart(state, t0 + CACHE_TTL_MS - 19_000);
		applyAssistantUsage(state, {
			now: t0 + CACHE_TTL_MS - 18_000,
			usage: usage({ cacheRead: 1_000, output: 1 }),
			model: RATES,
		});

		const startedAt = t0 + CACHE_TTL_MS - 1_000;
		noteTurnStart(state, startedAt);
		applyAssistantUsage(state, {
			now: t0 + CACHE_TTL_MS + 5_000,
			usage: usage({ cacheRead: 9_000, input: 10 }),
			model: RATES,
		});
		assert.equal(state.metrics.likelyAvoidedMisses, 0);
	});

	it("closes the chain on an ordinary turn before expiry without a hit", () => {
		const state = createWarmState();
		const t0 = 0;
		seedCache(state, t0);
		beginWarmPing(state, t0 + CACHE_TTL_MS - 30_000);
		noteTurnStart(state, t0 + CACHE_TTL_MS - 29_000);
		applyAssistantUsage(state, {
			now: t0 + CACHE_TTL_MS - 28_000,
			usage: usage({ cacheRead: 1_000 }),
			model: RATES,
		});

		noteTurnStart(state, t0 + 60_000);
		applyAssistantUsage(state, {
			now: t0 + 61_000,
			usage: usage({ cacheRead: 8_000 }),
			model: RATES,
		});
		assert.equal(state.metrics.likelyAvoidedMisses, 0);

		noteTurnStart(state, t0 + CACHE_TTL_MS + 10_000);
		applyAssistantUsage(state, {
			now: t0 + CACHE_TTL_MS + 11_000,
			usage: usage({ cacheRead: 8_000 }),
			model: RATES,
		});
		assert.equal(state.metrics.likelyAvoidedMisses, 0);
	});

	it("still attributes an avoided miss when a later user message is not an in-flight race", () => {
		const state = createWarmState();
		const t0 = 0;
		seedCache(state, t0);
		beginWarmPing(state, t0 + CACHE_TTL_MS - 20_000);
		noteTurnStart(state, t0 + CACHE_TTL_MS - 19_000);
		applyAssistantUsage(state, {
			now: t0 + CACHE_TTL_MS - 18_000,
			usage: usage({ cacheRead: 1_000 }),
			model: RATES,
		});
		noteTurnEnd(state);
		noteInterveningTurn(state);
		noteTurnStart(state, t0 + CACHE_TTL_MS + 5_000);
		applyAssistantUsage(state, {
			now: t0 + CACHE_TTL_MS + 6_000,
			usage: usage({ cacheRead: 9_000 }),
			model: RATES,
		});
		assert.equal(state.metrics.likelyAvoidedMisses, 1);
	});

	it("does not treat an intervening user turn as a warm refresh or avoided miss", () => {
		const state = createWarmState();
		const t0 = 0;
		seedCache(state, t0);
		beginWarmPing(state, t0 + CACHE_TTL_MS - 20_000);
		noteTurnStart(state, t0 + CACHE_TTL_MS - 19_000);
		noteInterveningTurn(state);
		applyAssistantUsage(state, {
			now: t0 + CACHE_TTL_MS + 5_000,
			usage: usage({ cacheRead: 12_000, input: 80, output: 20 }),
			model: RATES,
		});
		assert.equal(state.metrics.warmRefreshes, 0);
		assert.equal(state.metrics.likelyAvoidedMisses, 0);
		assert.equal(state.metrics.warmAttempts, 1);
		assert.ok(state.metrics.warmSpendUsd > 0);
	});

	it("does not count an avoided miss without a confirmed warm refresh", () => {
		const state = createWarmState();
		const t0 = 0;
		seedCache(state, t0);
		beginWarmPing(state, t0 + CACHE_TTL_MS - 20_000);
		noteTurnStart(state, t0 + CACHE_TTL_MS - 19_000);
		applyAssistantUsage(state, {
			now: t0 + CACHE_TTL_MS - 18_000,
			usage: usage({ input: 20, output: 1 }),
			model: RATES,
		});

		noteTurnStart(state, t0 + CACHE_TTL_MS + 10_000);
		applyAssistantUsage(state, {
			now: t0 + CACHE_TTL_MS + 11_000,
			usage: usage({ cacheRead: 9_000 }),
			model: RATES,
		});
		assert.equal(state.metrics.warmRefreshes, 0);
		assert.equal(state.metrics.likelyAvoidedMisses, 0);
	});

	it("does not count a hit at exact counterfactual expiry", () => {
		const state = createWarmState();
		const t0 = 0;
		seedCache(state, t0);
		beginWarmPing(state, t0 + CACHE_TTL_MS - 20_000);
		noteTurnStart(state, t0 + CACHE_TTL_MS - 19_000);
		applyAssistantUsage(state, {
			now: t0 + CACHE_TTL_MS - 18_000,
			usage: usage({ cacheRead: 1_000 }),
			model: RATES,
		});

		noteTurnStart(state, t0 + CACHE_TTL_MS);
		applyAssistantUsage(state, {
			now: t0 + CACHE_TTL_MS + 1_000,
			usage: usage({ cacheRead: 9_000 }),
			model: RATES,
		});
		assert.equal(state.metrics.likelyAvoidedMisses, 0);
	});

	it("reports N/A when model rates are missing", () => {
		const state = createWarmState();
		const t0 = 0;
		seedCache(state, t0);
		beginWarmPing(state, t0 + CACHE_TTL_MS - 20_000);
		noteTurnStart(state, t0 + CACHE_TTL_MS - 19_000);
		applyAssistantUsage(state, {
			now: t0 + CACHE_TTL_MS - 18_000,
			usage: usage({ cacheRead: 1_000, output: 1 }),
		});
		noteTurnStart(state, t0 + CACHE_TTL_MS + 5_000);
		applyAssistantUsage(state, {
			now: t0 + CACHE_TTL_MS + 6_000,
			usage: usage({ cacheRead: 8_000 }),
		});
		assert.equal(state.metrics.likelyAvoidedMisses, 1);
		assert.match(formatMetrics(state.metrics), /estimated net USD saved: N\/A/);
		assert.equal(formatUsd(null), "N/A");
	});

	it("allows negative net savings when warm spend exceeds the discount", () => {
		const state = createWarmState();
		const t0 = 0;
		seedCache(state, t0);
		beginWarmPing(state, t0 + CACHE_TTL_MS - 20_000);
		noteTurnStart(state, t0 + CACHE_TTL_MS - 19_000);
		applyAssistantUsage(state, {
			now: t0 + CACHE_TTL_MS - 18_000,
			usage: usage({ input: 10_000, output: 2_000, cacheRead: 100 }),
			model: RATES,
		});
		noteTurnStart(state, t0 + CACHE_TTL_MS + 5_000);
		applyAssistantUsage(state, {
			now: t0 + CACHE_TTL_MS + 6_000,
			usage: usage({ cacheRead: 100, input: 10 }),
			model: RATES,
		});
		assert.equal(state.metrics.likelyAvoidedMisses, 1);
		assert.match(formatMetrics(state.metrics), /estimated net USD saved: -\$/);
	});

	it("does not double-count assistant messages in the same non-warm turn", () => {
		const state = createWarmState();
		const t0 = 0;
		seedCache(state, t0);
		beginWarmPing(state, t0 + CACHE_TTL_MS - 20_000);
		noteTurnStart(state, t0 + CACHE_TTL_MS - 19_000);
		applyAssistantUsage(state, {
			now: t0 + CACHE_TTL_MS - 18_000,
			usage: usage({ cacheRead: 1_000 }),
			model: RATES,
		});

		noteTurnStart(state, t0 + CACHE_TTL_MS + 5_000);
		applyAssistantUsage(state, {
			now: t0 + CACHE_TTL_MS + 6_000,
			usage: usage({ cacheRead: 8_000 }),
			model: RATES,
		});
		applyAssistantUsage(state, {
			now: t0 + CACHE_TTL_MS + 7_000,
			usage: usage({ cacheRead: 8_000 }),
			model: RATES,
		});
		assert.equal(state.metrics.likelyAvoidedMisses, 1);
	});
});

describe("session and model resets", () => {
	it("clears the chain on model/provider change", () => {
		const state = createWarmState();
		const t0 = 0;
		seedCache(state, t0);
		state.modelKey = "anthropic/claude";
		beginWarmPing(state, t0 + CACHE_TTL_MS - 20_000);
		noteTurnStart(state, t0 + CACHE_TTL_MS - 19_000);
		applyAssistantUsage(state, {
			now: t0 + CACHE_TTL_MS - 18_000,
			usage: usage({ cacheRead: 1_000 }),
			model: RATES,
		});
		applyModelChange(state, "openai/gpt");
		assert.equal(state.cacheLastActive, undefined);
		assert.equal(state.inFlight, false);
		noteTurnStart(state, t0 + CACHE_TTL_MS + 10_000);
		applyAssistantUsage(state, {
			now: t0 + CACHE_TTL_MS + 11_000,
			usage: usage({ cacheRead: 9_000 }),
			model: RATES,
		});
		assert.equal(state.metrics.likelyAvoidedMisses, 0);
	});

	it("invalidates an open chain on disable without wiping metrics", () => {
		const state = createWarmState();
		const t0 = 0;
		seedCache(state, t0);
		beginWarmPing(state, t0 + CACHE_TTL_MS - 20_000);
		noteTurnStart(state, t0 + CACHE_TTL_MS - 19_000);
		applyAssistantUsage(state, {
			now: t0 + CACHE_TTL_MS - 18_000,
			usage: usage({ cacheRead: 1_000 }),
			model: RATES,
		});
		setEnabled(state, false);
		assert.equal(state.enabled, false);
		assert.equal(state.metrics.warmAttempts, 1);
		noteTurnStart(state, t0 + CACHE_TTL_MS + 10_000);
		applyAssistantUsage(state, {
			now: t0 + CACHE_TTL_MS + 11_000,
			usage: usage({ cacheRead: 9_000 }),
			model: RATES,
		});
		assert.equal(state.metrics.likelyAvoidedMisses, 0);
	});

	it("resets enabled, lastActive, in-flight, and metrics on session shutdown", () => {
		const state = createWarmState();
		state.enabled = true;
		seedCache(state, 0);
		beginWarmPing(state, CACHE_TTL_MS - 20_000);
		resetSession(state);
		assert.equal(state.enabled, false);
		assert.equal(state.cacheLastActive, undefined);
		assert.equal(state.inFlight, false);
		assert.equal(state.metrics.warmAttempts, 0);
		assert.equal(formatWarmFooter(state, Date.now()), undefined);
	});
});
