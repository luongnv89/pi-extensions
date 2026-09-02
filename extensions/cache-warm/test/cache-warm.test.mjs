import { describe, it } from "node:test";
import assert from "node:assert/strict";
import cacheWarmExtension, {
	CACHE_TTL_LONG_MS,
	CACHE_TTL_MS,
	CACHE_WARN_MS,
	DEFAULT_ACTIVE_MS,
	DEFAULT_MAX_PINGS_PER_HOUR,
	PING_CONTENT,
	RATE_WINDOW_MS,
	WARM_TIMEOUT_MS,
	buildPingContent,
	applyAssistantUsage,
	applyModelChange,
	beginWarmDispatch,
	confirmWarmDispatch,
	createWarmState,
	estimateGrossBenefitUsd,
	estimateTurnUsd,
	expirePendingDispatch,
	failPendingDispatch,
	formatMetrics,
	formatStatusReport,
	inferMissBillingMode,
	noteAgentSettled,
	noteAgentStart,
	noteExternalInput,
	noteTurnStart,
	parseCacheWarmArgs,
	parseDurationMs,
	resetSession,
	setActiveMs,
	setEnabled,
	setRateLimitEnabled,
	shouldSendWarmPing,
	underRateLimit,
} from "../dist/index.js";

function model(overrides = {}) {
	return {
		id: "test-model",
		name: "Test model",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 10, output: 20, cacheRead: 1, cacheWrite: 12 },
		contextWindow: 200_000,
		maxTokens: 8_000,
		...overrides,
	};
}

function usage(partial = {}) {
	const base = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const merged = { ...base, ...partial, cost: { ...base.cost, ...(partial.cost ?? {}) } };
	if (!partial.totalTokens) {
		merged.totalTokens = merged.input + merged.output + merged.cacheRead + merged.cacheWrite;
	}
	return merged;
}

function seedCache(state, at, selectedModel = model(), extraUsage = {}) {
	noteAgentStart(state);
	noteTurnStart(state, at);
	applyAssistantUsage(state, {
		usage: usage({ input: 20, cacheWrite: 100, ...extraUsage }),
		model: selectedModel,
	});
	noteAgentSettled(state);
}

function startWarm(state, at, selectedModel = model()) {
	const dispatch = beginWarmDispatch(state, at, selectedModel);
	assert.ok(dispatch);
	noteAgentStart(state);
	noteTurnStart(state, at + 1);
	assert.deepEqual(confirmWarmDispatch(state, dispatch.id), { confirmed: true, abort: false });
	return dispatch;
}

function gate(state, now, overrides = {}) {
	return {
		enabled: state.enabled,
		now,
		cacheLastActive: state.cacheLastActive,
		cacheEpoch: state.cacheEpoch,
		dispatchPending: state.dispatchPending !== undefined,
		warmRunActive: state.warmRunActive !== undefined,
		suppressedEpoch: state.suppressedEpoch,
		activeMs: state.activeMs,
		lastUserActivityAt: state.lastUserActivityAt,
		pingSentAt: state.pingSentAt,
		maxPerHour: state.maxPerHour,
		rateLimitEnabled: state.rateLimitEnabled,
		idle: true,
		hasPendingMessages: false,
		ttlMs: state.retention?.ttlMs,
		...overrides,
	};
}

describe("commands and dispatch state", () => {
	it("keeps warming off by default and parses easy toggles", () => {
		assert.equal(createWarmState().enabled, false);
		assert.equal(createWarmState().activeMs, DEFAULT_ACTIVE_MS);
		assert.equal(
			createWarmState().maxPerHour,
			Math.ceil(RATE_WINDOW_MS / (CACHE_TTL_MS - CACHE_WARN_MS)),
		);
		assert.equal(createWarmState().maxPerHour, DEFAULT_MAX_PINGS_PER_HOUR);
		assert.equal(createWarmState().rateLimitEnabled, true);
		assert.equal(parseCacheWarmArgs("").action, "toggle");
		assert.deepEqual(parseCacheWarmArgs("rate"), { action: "rate" });
		assert.deepEqual(parseCacheWarmArgs("rate on"), { action: "rate", rateEnabled: true });
		assert.deepEqual(parseCacheWarmArgs("rate off"), { action: "rate", rateEnabled: false });
		assert.equal(parseCacheWarmArgs("on").action, "on");
		assert.equal(parseCacheWarmArgs("disable").action, "off");
		assert.equal(parseDurationMs("30m"), DEFAULT_ACTIVE_MS);
		assert.equal(parseDurationMs("1h"), 60 * 60 * 1000);
		assert.equal(parseDurationMs("2h"), 2 * 60 * 60 * 1000);
		assert.equal(parseDurationMs("90"), 90 * 60 * 1000);
		assert.equal(parseDurationMs("forever"), 0);
		assert.deepEqual(parseCacheWarmArgs("duration 1h"), { action: "duration", durationMs: 60 * 60 * 1000 });
		assert.deepEqual(parseCacheWarmArgs("30m"), { action: "duration", durationMs: DEFAULT_ACTIVE_MS });
	});

	it("separates pending dispatch from confirmed attempts", () => {
		const state = createWarmState();
		const selectedModel = model();
		state.modelKey = "openai/test-model";
		setEnabled(state, true);
		seedCache(state, 1_000, selectedModel);
		const dispatch = beginWarmDispatch(state, 10_000, selectedModel);
		assert.ok(dispatch);
		assert.equal(state.metrics.warmAttempts, 0);
		assert.equal(state.dispatchPending?.id, dispatch.id);
		noteTurnStart(state, 10_001);
		assert.equal(confirmWarmDispatch(state, dispatch.id).confirmed, true);
		assert.equal(state.metrics.warmAttempts, 1);
		assert.ok(state.warmRunActive);
	});

	it("suppresses timeout retries for the same cache epoch", () => {
		const state = createWarmState();
		const selectedModel = model();
		state.modelKey = "openai/test-model";
		setEnabled(state, true);
		seedCache(state, 1_000, selectedModel);
		beginWarmDispatch(state, 10_000, selectedModel);
		assert.equal(expirePendingDispatch(state, 10_000 + WARM_TIMEOUT_MS), true);
		assert.equal(state.metrics.warmAttempts, 0);
		assert.equal(shouldSendWarmPing(gate(state, 10_000 + WARM_TIMEOUT_MS)), false);

		noteExternalInput(state);
		noteTurnStart(state, 20_000);
		applyAssistantUsage(state, { usage: usage({ cacheRead: 50 }), model: selectedModel });
		assert.equal(state.suppressedEpoch, undefined);
	});

	it("quarantines a late timed-out dispatch", () => {
		const state = createWarmState();
		const selectedModel = model();
		state.modelKey = "openai/test-model";
		setEnabled(state, true);
		seedCache(state, 1_000, selectedModel);
		const dispatch = beginWarmDispatch(state, 10_000, selectedModel);
		expirePendingDispatch(state, 10_000 + WARM_TIMEOUT_MS);
		noteTurnStart(state, 80_001);
		assert.deepEqual(confirmWarmDispatch(state, dispatch.id), { confirmed: true, abort: true });
		assert.equal(state.metrics.warmAttempts, 1);
		assert.equal(state.warmRunActive?.interrupted, true);
	});

	it("retains every stale token for the session and aborts overlapping recognized starts", () => {
		const state = createWarmState();
		const selectedModel = model();
		state.modelKey = "openai/test-model";
		setEnabled(state, true);
		seedCache(state, 1_000, selectedModel);
		const stale = [];
		for (let index = 0; index < 40; index += 1) {
			const dispatch = beginWarmDispatch(state, 10_000 + index, selectedModel);
			stale.push(dispatch);
			expirePendingDispatch(state, 10_000 + index + WARM_TIMEOUT_MS);
			setEnabled(state, false);
			setEnabled(state, true);
		}
		assert.equal(state.staleDispatches.size, 40);
		const active = beginWarmDispatch(state, 100_000, selectedModel);
		noteTurnStart(state, 100_001);
		confirmWarmDispatch(state, active.id);
		assert.deepEqual(confirmWarmDispatch(state, stale[0].id), { confirmed: true, abort: true });
		assert.ok(state.warmRunActive);
		assert.equal(state.metrics.warmAttempts, 2);
	});

	it("clears a suppressed epoch when /cache-warm on is issued while already enabled", () => {
		const state = createWarmState();
		const selectedModel = model();
		state.modelKey = "openai/test-model";
		seedCache(state, 1_000, selectedModel);
		const pingAt = 1_000 + CACHE_TTL_MS - 30_000;
		beginWarmDispatch(state, pingAt, selectedModel);
		failPendingDispatch(state);
		assert.equal(shouldSendWarmPing(gate(state, pingAt)), false);
		assert.equal(setEnabled(state, true), false);
		assert.equal(state.suppressedEpoch, undefined);
		assert.equal(shouldSendWarmPing(gate(state, pingAt)), true);
	});

	it("stops warming after the idle duration and resumes on a user turn", () => {
		const state = createWarmState();
		const selectedModel = model();
		state.modelKey = "openai/test-model";
		setEnabled(state, true);
		const pingAt = 1_000 + CACHE_TTL_MS - 30_000;
		seedCache(state, 1_000, selectedModel);
		setActiveMs(state, 10 * 60_000);
		noteExternalInput(state, 1_000);
		assert.equal(shouldSendWarmPing(gate(state, pingAt)), true);

		setActiveMs(state, 60_000);
		assert.equal(shouldSendWarmPing(gate(state, pingAt)), false);
		assert.match(formatStatusReport(state, pingAt), /idle limit: 0:00 of 1m remaining/);

		noteExternalInput(state, pingAt);
		assert.equal(shouldSendWarmPing(gate(state, pingAt)), true);
	});

	it("varies ping bodies and caps sends without blocking the default cadence", () => {
		const first = buildPingContent(1_700_000_000_000, "abc");
		const second = buildPingContent(1_700_000_000_001, "def");
		assert.match(first, new RegExp(`^${PING_CONTENT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} #w `));
		assert.notEqual(first, second);

		const interval = CACHE_TTL_MS - CACHE_WARN_MS;
		const priorDefaultPings = Array.from(
			{ length: DEFAULT_MAX_PINGS_PER_HOUR },
			(_, index) => (index + 1) * interval,
		);
		assert.equal(
			underRateLimit(
				(DEFAULT_MAX_PINGS_PER_HOUR + 1) * interval,
				priorDefaultPings,
				DEFAULT_MAX_PINGS_PER_HOUR,
			),
			true,
		);

		const state = createWarmState();
		const selectedModel = model();
		state.modelKey = "openai/test-model";
		state.maxPerHour = 2;
		setEnabled(state, true);
		seedCache(state, 1_000, selectedModel);
		const pingAt = 1_000 + CACHE_TTL_MS - 30_000;
		assert.equal(shouldSendWarmPing(gate(state, pingAt)), true);
		beginWarmDispatch(state, pingAt, selectedModel);
		failPendingDispatch(state);
		setEnabled(state, true);
		beginWarmDispatch(state, pingAt + 1, selectedModel);
		failPendingDispatch(state);
		setEnabled(state, true);
		assert.equal(shouldSendWarmPing(gate(state, pingAt + 2)), false);
		assert.match(formatStatusReport(state, pingAt + 2), /rate limit: on · 2\/2 pings in the last hour/);
		setRateLimitEnabled(state, false);
		assert.equal(shouldSendWarmPing(gate(state, pingAt + 2)), true);
		assert.match(formatStatusReport(state, pingAt + 2), /rate limit: off/);
		setRateLimitEnabled(state, true);
		const later = pingAt + 3_600_000;
		state.cacheLastActive = later - (CACHE_TTL_MS - 30_000);
		assert.equal(shouldSendWarmPing(gate(state, later)), true);
	});
});

describe("warm ownership, cache clock, and attribution", () => {
	it("charges every continuation, refreshes once, and attributes only a later external run", () => {
		const state = createWarmState();
		const selectedModel = model();
		state.modelKey = "openai/test-model";
		setEnabled(state, true);
		const t0 = 1_000_000;
		seedCache(state, t0, selectedModel);
		startWarm(state, t0 + CACHE_TTL_MS - 30_000, selectedModel);

		applyAssistantUsage(state, {
			usage: usage({ cacheRead: 1_000, cost: { cacheRead: 0.1, total: 0.1 } }),
			model: selectedModel,
		});
		noteTurnStart(state, t0 + CACHE_TTL_MS + 5_000);
		applyAssistantUsage(state, {
			usage: usage({ cacheRead: 800, cost: { cacheRead: 0.2, total: 0.2 } }),
			model: selectedModel,
		});
		assert.ok(Math.abs(state.metrics.warmSpendUsd - 0.3) < 1e-12);
		assert.equal(state.metrics.warmRefreshes, 1);
		assert.equal(state.metrics.likelyAvoidedMisses, 0);

		noteAgentSettled(state);
		noteExternalInput(state);
		noteAgentStart(state);
		noteTurnStart(state, t0 + CACHE_TTL_MS + 10_000);
		applyAssistantUsage(state, {
			usage: usage({ cacheRead: 5_000, output: 5 }),
			model: selectedModel,
		});
		assert.equal(state.metrics.likelyAvoidedMisses, 1);
	});

	it("preserves the first external request start across continuations", () => {
		const state = createWarmState();
		const selectedModel = model();
		state.modelKey = "openai/test-model";
		setEnabled(state, true);
		const t0 = 0;
		seedCache(state, t0, selectedModel);
		startWarm(state, CACHE_TTL_MS - 20_000, selectedModel);
		applyAssistantUsage(state, { usage: usage({ cacheRead: 100 }), model: selectedModel });
		noteAgentSettled(state);

		noteExternalInput(state);
		noteAgentStart(state);
		noteTurnStart(state, CACHE_TTL_MS - 1);
		applyAssistantUsage(state, { usage: usage({ output: 1 }), model: selectedModel });
		noteTurnStart(state, CACHE_TTL_MS + 20_000);
		applyAssistantUsage(state, { usage: usage({ cacheRead: 5_000 }), model: selectedModel });
		assert.equal(state.metrics.likelyAvoidedMisses, 0);
	});

	it("anchors cache activity to turn_start despite a long response", () => {
		const state = createWarmState();
		noteAgentStart(state);
		noteTurnStart(state, 10_000);
		applyAssistantUsage(state, {
			usage: usage({ cacheRead: 1_000 }),
			model: model(),
		});
		assert.equal(state.cacheLastActive, 10_000);
	});

	it("does not let old stale tombstones hide a later external avoided miss", () => {
		const state = createWarmState();
		const selectedModel = model();
		state.modelKey = "openai/test-model";
		setEnabled(state, true);
		seedCache(state, 0, selectedModel);
		beginWarmDispatch(state, 1_000, selectedModel);
		expirePendingDispatch(state, 1_000 + WARM_TIMEOUT_MS);
		setEnabled(state, false);
		setEnabled(state, true);
		startWarm(state, CACHE_TTL_MS - 20_000, selectedModel);
		applyAssistantUsage(state, { usage: usage({ cacheRead: 100 }), model: selectedModel });
		noteAgentSettled(state);
		noteExternalInput(state);
		noteAgentStart(state);
		noteTurnStart(state, CACHE_TTL_MS + 1);
		applyAssistantUsage(state, { usage: usage({ cacheRead: 1_000 }), model: selectedModel });
		assert.equal(state.metrics.likelyAvoidedMisses, 1);
	});

	it("waits through usage-less retries but keeps first-request eligibility fixed", () => {
		const selectedModel = model();
		for (const [firstStart, expected] of [
			[CACHE_TTL_MS + 1, 1],
			[CACHE_TTL_MS - 1, 0],
		]) {
			const state = createWarmState();
			state.modelKey = "openai/test-model";
			setEnabled(state, true);
			seedCache(state, 0, selectedModel);
			startWarm(state, CACHE_TTL_MS - 20_000, selectedModel);
			applyAssistantUsage(state, { usage: usage({ cacheRead: 100 }), model: selectedModel });
			noteAgentSettled(state);
			noteExternalInput(state);
			noteAgentStart(state);
			noteTurnStart(state, firstStart);
			applyAssistantUsage(state, { usage: usage(), model: selectedModel });
			noteTurnStart(state, CACHE_TTL_MS + 10_000);
			applyAssistantUsage(state, { usage: usage({ cacheRead: 1_000 }), model: selectedModel });
			assert.equal(state.metrics.likelyAvoidedMisses, expected);
		}
	});

	it("falls back to Pi-native pricing when warm usage has no valid reported cost", () => {
		const state = createWarmState();
		const selectedModel = model();
		state.modelKey = "openai/test-model";
		setEnabled(state, true);
		seedCache(state, 0, selectedModel);
		startWarm(state, 1_000, selectedModel);
		applyAssistantUsage(state, {
			usage: { input: 1_000, output: 0, cacheRead: 100, cacheWrite: 0, totalTokens: 1_100 },
			model: selectedModel,
		});
		assert.ok(Math.abs(state.metrics.warmSpendUsd - 0.0101) < 1e-12);
	});

	it("interrupts an active run without clearing ownership before settlement", () => {
		const state = createWarmState();
		const selectedModel = model();
		state.modelKey = "openai/test-model";
		setEnabled(state, true);
		seedCache(state, 0, selectedModel);
		startWarm(state, CACHE_TTL_MS - 10_000, selectedModel);
		assert.equal(noteExternalInput(state), true);
		assert.ok(state.warmRunActive);
		assert.equal(noteExternalInput(state), false);
		applyAssistantUsage(state, {
			usage: usage({ cacheRead: 100, cost: { cacheRead: 0.05, total: 0.05 } }),
			model: selectedModel,
		});
		assert.equal(state.metrics.warmSpendUsd, 0.05);
		noteAgentSettled(state);
		assert.equal(state.warmRunActive, undefined);
		assert.equal(state.metrics.likelyAvoidedMisses, 0);
	});
});

describe("cache retention", () => {
	const anthropicModel = () =>
		model({ api: "anthropic-messages", provider: "anthropic", cost: { input: 10, output: 20, cacheRead: 1, cacheWrite: 12 } });

	it("uses the short Anthropic TTL and five-minute miss mode", () => {
		const state = createWarmState();
		const selectedModel = anthropicModel();
		state.modelKey = "anthropic/test-model";
		setEnabled(state, true);
		seedCache(state, 1_000, selectedModel);
		assert.deepEqual(state.retention, {
			kind: "short",
			ttlMs: CACHE_TTL_MS,
			missMode: "cacheWrite",
			attributionAllowed: true,
		});
		assert.equal(shouldSendWarmPing(gate(state, 1_000 + CACHE_TTL_MS - 30_000)), true);
	});

	it("keeps full one-hour writes warm for one hour and snapshots that expiry", () => {
		const state = createWarmState();
		const selectedModel = anthropicModel();
		state.modelKey = "anthropic/test-model";
		setEnabled(state, true);
		seedCache(state, 1_000, selectedModel, { cacheWrite1h: 100 });
		assert.equal(state.retention?.kind, "long");
		assert.equal(state.retention?.ttlMs, CACHE_TTL_LONG_MS);
		assert.equal(shouldSendWarmPing(gate(state, 1_000 + CACHE_TTL_MS - 30_000)), false);
		assert.equal(shouldSendWarmPing(gate(state, 1_000 + CACHE_TTL_LONG_MS - 30_000)), true);

		const dispatch = beginWarmDispatch(state, 1_000 + CACHE_TTL_LONG_MS - 30_000, selectedModel);
		assert.ok(dispatch);
		noteTurnStart(state, 1_000 + CACHE_TTL_LONG_MS - 29_999);
		confirmWarmDispatch(state, dispatch.id);
		assert.equal(state.chain?.counterfactualExpiry, 1_000 + CACHE_TTL_LONG_MS);
		assert.equal(state.chain?.missMode, "cacheWrite1h");

		applyAssistantUsage(state, { usage: usage({ cacheRead: 100 }), model: selectedModel });
		assert.equal(state.retention?.kind, "long", "read-only activity retains known retention");
		applyModelChange(state, "anthropic/other");
		assert.equal(state.retention, undefined);
	});

	it("warms mixed writes conservatively without claiming a miss or savings", () => {
		const state = createWarmState();
		const selectedModel = anthropicModel();
		state.modelKey = "anthropic/test-model";
		setEnabled(state, true);
		seedCache(state, 0, selectedModel, { cacheWrite1h: 40 });
		assert.deepEqual(state.retention, {
			kind: "mixed",
			ttlMs: CACHE_TTL_MS,
			missMode: null,
			attributionAllowed: false,
		});
		assert.equal(shouldSendWarmPing(gate(state, CACHE_TTL_MS - 30_000)), true);
		startWarm(state, CACHE_TTL_MS - 20_000, selectedModel);
		applyAssistantUsage(state, { usage: usage({ cacheRead: 100 }), model: selectedModel });
		noteAgentSettled(state);
		noteExternalInput(state);
		noteAgentStart(state);
		noteTurnStart(state, CACHE_TTL_MS + 1);
		applyAssistantUsage(state, { usage: usage({ cacheRead: 1_000 }), model: selectedModel });
		assert.equal(state.metrics.likelyAvoidedMisses, 0);
		assert.match(formatMetrics(state.metrics), /N\/A/);
	});

	it("makes mixed retention discovered by the warm turn sticky for attribution", () => {
		const state = createWarmState();
		const selectedModel = anthropicModel();
		state.modelKey = "anthropic/test-model";
		setEnabled(state, true);
		seedCache(state, 0, selectedModel);
		startWarm(state, CACHE_TTL_MS - 20_000, selectedModel);
		applyAssistantUsage(state, {
			usage: usage({ cacheWrite: 100, cacheWrite1h: 40 }),
			model: selectedModel,
		});
		noteAgentSettled(state);
		noteExternalInput(state);
		noteAgentStart(state);
		noteTurnStart(state, CACHE_TTL_MS + 1);
		applyAssistantUsage(state, { usage: usage({ cacheRead: 1_000 }), model: selectedModel });
		assert.equal(state.metrics.likelyAvoidedMisses, 0);
		assert.match(formatMetrics(state.metrics), /N\/A/);
	});
});

describe("Pi-native pricing", () => {
	it("honors tiered rates and preserves cacheWrite1h pricing", () => {
		const selectedModel = model({
			cost: {
				input: 10,
				output: 20,
				cacheRead: 1,
				cacheWrite: 12,
				tiers: [{ inputTokensAbove: 100, input: 20, output: 40, cacheRead: 2, cacheWrite: 24 }],
			},
		});
		const full = usage({ cacheWrite: 150, cacheWrite1h: 150 });
		assert.equal(estimateTurnUsd(selectedModel, { ...full, cost: undefined }), 0.006);
		assert.equal(estimateTurnUsd(selectedModel, { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000 }), 0.02);
		assert.equal(
			estimateTurnUsd(selectedModel, usage({ input: 1_000, cost: { input: 0, total: 0.5 } })),
			0.02,
		);
		assert.equal(estimateTurnUsd(selectedModel, { ...full, cacheWrite1h: 151, cost: undefined }), null);
		assert.equal(
			estimateTurnUsd(selectedModel, usage({ cacheWrite: 150, cacheWrite1h: 151, cost: { cacheWrite: 1, total: 1 } })),
			null,
		);
	});

	it("calculates known input, 5-minute write, and 1-hour write counterfactuals", () => {
		const selectedModel = model();
		const actual = usage({ cacheRead: 1_000, cost: { cacheRead: 0.001, total: 0.001 } });
		assert.ok(Math.abs(estimateGrossBenefitUsd(selectedModel, actual, "input") - 0.009) < 1e-12);
		assert.ok(Math.abs(estimateGrossBenefitUsd(selectedModel, actual, "cacheWrite") - 0.011) < 1e-12);
		assert.ok(Math.abs(estimateGrossBenefitUsd(selectedModel, actual, "cacheWrite1h") - 0.019) < 1e-12);
	});

	it("preserves observed OpenAI flex and priority service-tier multipliers", () => {
		for (const [id, multiplier, expected] of [
			["gpt-5", 0.5, 0.0045],
			["gpt-5", 2, 0.018],
			["gpt-5.5", 2.5, 0.0225],
		]) {
			const actual = usage({
				cacheRead: 1_000,
				cost: { cacheRead: 0.001 * multiplier, total: 0.001 * multiplier },
			});
			assert.ok(Math.abs(estimateGrossBenefitUsd(model({ id }), actual, "input") - expected) < 1e-12);
		}
	});

	it("preserves the observed Codex flex service-tier multiplier", () => {
		const actual = usage({ cacheRead: 1_000, cost: { cacheRead: 0.0005, total: 0.0005 } });
		assert.ok(
			Math.abs(
				estimateGrossBenefitUsd(
					model({ api: "openai-codex-responses", provider: "openai-codex", id: "gpt-5" }),
					actual,
					"input",
				) - 0.0045,
			) < 1e-12,
		);
	});

	it("preserves the observed Codex ordinary priority service-tier multiplier", () => {
		const actual = usage({ cacheRead: 1_000, cost: { cacheRead: 0.002, total: 0.002 } });
		assert.ok(
			Math.abs(
				estimateGrossBenefitUsd(
					model({ api: "openai-codex-responses", provider: "openai-codex", id: "gpt-5" }),
					actual,
					"input",
				) - 0.018,
			) < 1e-12,
		);
	});

	it("preserves the observed Codex GPT-5.5 2.5x service-tier multiplier", () => {
		const actual = usage({ cacheRead: 1_000, cost: { cacheRead: 0.0025, total: 0.0025 } });
		assert.ok(
			Math.abs(
				estimateGrossBenefitUsd(
					model({ api: "openai-codex-responses", provider: "openai-codex", id: "gpt-5.5" }),
					actual,
					"input",
				) - 0.0225,
			) < 1e-12,
		);
	});

	it("returns N/A for missing or invalid Codex service-tier multiplier evidence", () => {
		const selectedModel = model({ api: "openai-codex-responses", provider: "openai-codex" });
		assert.equal(
			estimateGrossBenefitUsd(
				selectedModel,
				{ ...usage({ cacheRead: 1_000 }), cost: undefined },
				"input",
			),
			null,
		);
		assert.equal(
			estimateGrossBenefitUsd(
				selectedModel,
				usage({ cacheRead: 1_000, cost: { input: 0.001, cacheRead: 0, total: 0.001 } }),
				"input",
			),
			null,
		);
	});

	it("returns N/A when a service-tier multiplier cannot be inferred safely", () => {
		assert.equal(
			estimateGrossBenefitUsd(
				model(),
				usage({ cacheRead: 1_000, cost: { input: 0.001, cacheRead: 0, total: 0.001 } }),
				"input",
			),
			null,
		);
		assert.equal(
			estimateGrossBenefitUsd(
				model({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
				usage({ cacheRead: 1_000 }),
				"input",
			),
			null,
		);
	});

	it("infers only defensible provider modes and reports unknown pricing as N/A", () => {
		assert.equal(inferMissBillingMode(model(), usage()), "input");
		assert.equal(
			inferMissBillingMode(model({ api: "anthropic-messages", provider: "anthropic" }), usage()),
			"cacheWrite",
		);
		assert.equal(
			inferMissBillingMode(
				model({ api: "anthropic-messages", provider: "anthropic" }),
				usage({ cacheWrite: 10, cacheWrite1h: 10 }),
			),
			"cacheWrite1h",
		);
		assert.equal(inferMissBillingMode(model({ api: "mystery-api", provider: "proxy" }), usage()), null);
		assert.equal(inferMissBillingMode(model({ provider: "proxy" }), usage()), null);
		assert.equal(estimateGrossBenefitUsd(model(), usage({ cacheRead: 1_000 }), null), null);
		const metrics = createWarmState().metrics;
		metrics.pricingKnown = false;
		assert.match(formatMetrics(metrics), /N\/A/);
	});
});

describe("reset safety", () => {
	it("disables pending and active runs without prematurely dropping an active guard", () => {
		const state = createWarmState();
		const selectedModel = model();
		state.modelKey = "openai/test-model";
		setEnabled(state, true);
		seedCache(state, 0, selectedModel);
		beginWarmDispatch(state, 1_000, selectedModel);
		assert.equal(setEnabled(state, false), false);
		assert.equal(state.dispatchPending, undefined);
		setEnabled(state, true);
		const dispatch = beginWarmDispatch(state, 2_000, selectedModel);
		noteTurnStart(state, 2_001);
		confirmWarmDispatch(state, dispatch.id);
		assert.equal(setEnabled(state, false), true);
		assert.ok(state.warmRunActive);
		noteAgentSettled(state);
		assert.equal(state.warmRunActive, undefined);
	});

	it("aborts and drains on model change, while shutdown hard-resets", () => {
		const state = createWarmState();
		const selectedModel = model();
		state.modelKey = "openai/test-model";
		setEnabled(state, true);
		seedCache(state, 0, selectedModel);
		startWarm(state, 1_000, selectedModel);
		assert.equal(applyModelChange(state, "anthropic/other"), true);
		assert.ok(state.warmRunActive);
		assert.equal(state.cacheLastActive, undefined);
		resetSession(state);
		assert.equal(state.warmRunActive, undefined);
		assert.equal(state.dispatchPending, undefined);
		assert.equal(state.enabled, false);
	});

	it("quarantines pending work on model change and clears pending work on shutdown", () => {
		const state = createWarmState();
		const selectedModel = model();
		state.modelKey = "openai/test-model";
		setEnabled(state, true);
		seedCache(state, 0, selectedModel);
		const pending = beginWarmDispatch(state, 1_000, selectedModel);
		assert.equal(applyModelChange(state, "anthropic/other"), false);
		assert.equal(state.dispatchPending, undefined);
		assert.ok(state.staleDispatches.has(pending.id));
		state.cacheLastActive = 2_000;
		beginWarmDispatch(state, 3_000, selectedModel);
		resetSession(state);
		assert.equal(state.dispatchPending, undefined);
		assert.equal(state.staleDispatches.size, 0);
	});
});

describe("extension event wiring", { concurrency: false }, () => {
	it("starts disabled without creating a keep-alive timer", async () => {
		const harness = createHarness();
		await harness.start();
		assert.match(await harness.status(), /cache-warm: off/);
		assert.equal(harness.unrefCalls, 0);
		assert.equal(harness.hasActiveTimer, false);
		await harness.seed(1_000);
		assert.equal(harness.sent.length, 0);
		harness.restore();
	});

	it("lets /cache-warm on, off, and empty-args toggle keep-alive", async () => {
		const harness = createHarness();
		await harness.start();
		assert.match(await harness.status(), /cache-warm: off/);

		await harness.command("");
		assert.match(await harness.status(), /cache-warm: on/);
		assert.equal(harness.hasActiveTimer, true);

		await harness.command("");
		assert.match(await harness.status(), /cache-warm: off/);
		assert.equal(harness.hasActiveTimer, false);

		await harness.seed(1_000);
		assert.equal(harness.sent.length, 0);

		await harness.command("on");
		assert.match(await harness.status(), /cache-warm: on/);
		assert.equal(harness.hasActiveTimer, true);
		harness.tickAt(1_000 + CACHE_TTL_MS - 29_000);
		assert.equal(harness.sent.length, 1);

		await harness.command("off");
		assert.match(await harness.status(), /cache-warm: off/);
		assert.equal(harness.hasActiveTimer, false);
		assert.equal(harness.clearIntervalCalls, 2);
		harness.restore();
	});

	it("resets explicit enablement after session_shutdown", async () => {
		const harness = createHarness();
		await harness.startAndEnable();
		assert.equal(harness.hasActiveTimer, true);
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		assert.equal(harness.hasActiveTimer, false);
		assert.equal(harness.clearIntervalCalls, 1);
		await harness.start();
		assert.match(await harness.status(), /cache-warm: off/);
		await harness.seed(1_000);
		assert.equal(harness.sent.length, 0);
		harness.restore();
	});

	it("hands off an interrupted warm run at Pi's queued user boundary", async () => {
		const harness = createHarness();
		await harness.startAndEnable();
		await harness.seed(1_000);
		harness.tickAt(1_000 + CACHE_TTL_MS - 30_000);
		assert.equal(harness.sent.length, 1);
		assert.match(await harness.metrics(), /attempts: 0/);
		assert.equal(await harness.emit("tool_call", toolEvent()), undefined);

		await harness.emit("agent_start", { type: "agent_start" });
		await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 271_001 });
		await harness.emit("message_start", { type: "message_start", message: harness.sent[0] });
		assert.match(await harness.metrics(), /attempts: 1/);
		await harness.emit("input", { type: "input", text: "real work", source: "interactive" });
		assert.equal(harness.abortCount, 1);
		assert.deepEqual(await harness.emit("tool_call", toolEvent()), {
			block: true,
			reason: "cache-warm hidden turns cannot call tools",
			terminate: true,
		});
		await harness.emit("message_end", {
			type: "message_end",
			message: { role: "assistant", usage: usage({ cacheRead: 100, cost: { cacheRead: 0.05, total: 0.05 } }) },
		});

		// Pi 0.84.2 emits turn_start before draining the queued user message.
		await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 280_000 });
		await harness.emit("message_start", { type: "message_start", message: { role: "user" } });
		assert.equal(await harness.emit("tool_call", toolEvent()), undefined);
		await harness.emit("message_end", {
			type: "message_end",
			message: { role: "assistant", usage: usage({ output: 1, cost: { output: 0.4, total: 0.4 } }) },
		});
		await harness.emit("agent_settled", { type: "agent_settled" });
		assert.match(await harness.metrics(), /estimated net USD saved: -\$0\.050/);
		harness.restore();
	});

	it("does not retry an unconfirmed dispatch in the same epoch", async () => {
		const harness = createHarness();
		await harness.startAndEnable();
		await harness.seed(1_000);
		const first = 1_000 + CACHE_TTL_MS - 30_000;
		harness.tickAt(first);
		assert.equal(harness.sent.length, 1);
		harness.tickAt(first + WARM_TIMEOUT_MS);
		harness.tickAt(first + WARM_TIMEOUT_MS + 10_000);
		assert.equal(harness.sent.length, 1);
		assert.match(await harness.metrics(), /attempts: 0/);
		harness.restore();
	});

	it("does not retry a synchronously failed send in the same epoch", async () => {
		const harness = createHarness({ sendThrows: true });
		await harness.startAndEnable();
		await harness.seed(1_000);
		const first = 1_000 + CACHE_TTL_MS - 30_000;
		harness.tickAt(first);
		harness.tickAt(first + 10_000);
		assert.equal(harness.sendCalls, 1);
		assert.match(await harness.metrics(), /attempts: 0/);
		harness.restore();
	});

	it("auto-stops keep-alive after the configured idle duration", async () => {
		const harness = createHarness();
		await harness.startAndEnable();
		await harness.command("duration 1m");
		assert.match(harness.notices.at(-1), /idle limit set to 1m/);
		await harness.seed(1_000);
		harness.tickAt(1_000 + 61_000);
		assert.match(await harness.status(), /cache-warm: off/);
		assert.equal(harness.hasActiveTimer, false);
		assert.equal(harness.clearIntervalCalls, 1);
		assert.equal(harness.sent.length, 0);
		harness.restore();
	});

	it("retries a failed send after /cache-warm on while already enabled", async () => {
		const harness = createHarness({ sendThrows: true });
		await harness.startAndEnable();
		await harness.seed(1_000);
		const first = 1_000 + CACHE_TTL_MS - 30_000;
		harness.tickAt(first);
		assert.equal(harness.sendCalls, 1);
		harness.tickAt(first + 10_000);
		assert.equal(harness.sendCalls, 1);
		await harness.command("on");
		harness.tickAt(first + 11_000);
		assert.equal(harness.sendCalls, 2);
		harness.restore();
	});

	it("keeps active tool blocking on disable/model change and clears on shutdown", async () => {
		const harness = createHarness();
		await harness.startAndEnable();
		await harness.seed(1_000);
		harness.tickAt(1_000 + CACHE_TTL_MS - 30_000);
		await harness.emit("agent_start", { type: "agent_start" });
		await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 271_001 });
		await harness.emit("message_start", { type: "message_start", message: harness.sent[0] });
		await harness.command("off");
		assert.equal(harness.abortCount, 1);
		assert.equal((await harness.emit("tool_call", toolEvent())).block, true);
		await harness.emit("model_select", {
			type: "model_select",
			model: model({ id: "other" }),
			previousModel: harness.ctx.model,
			source: "set",
		});
		assert.equal(harness.abortCount, 1);
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		assert.equal(await harness.emit("tool_call", toolEvent()), undefined);
		harness.restore();
	});
});

function toolEvent() {
	return { type: "tool_call", toolName: "bash", toolCallId: "tool-1", input: { command: "touch bad" } };
}

function createHarness(options = {}) {
	const handlers = new Map();
	let commandHandler;
	let timerCallback;
	let activeTimer;
	let now = 0;
	let unrefCalls = 0;
	let clearIntervalCalls = 0;
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	const originalDateNow = Date.now;
	globalThis.setInterval = (callback) => {
		timerCallback = callback;
		activeTimer = {
			fake: true,
			unref() {
				unrefCalls += 1;
			},
		};
		return activeTimer;
	};
	globalThis.clearInterval = (timer) => {
		clearIntervalCalls += 1;
		if (timer === activeTimer) activeTimer = undefined;
	};
	Date.now = () => now;
	const sent = [];
	const notices = [];
	const selectedModel = model();
	let abortCount = 0;
	let sendCalls = 0;
	const ctx = {
		model: selectedModel,
		hasUI: true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {
			abortCount += 1;
		},
		ui: {
			setStatus: () => {},
			notify: (message) => notices.push(message),
		},
	};
	const pi = {
		on(name, handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand(_name, definition) {
			commandHandler = definition.handler;
		},
		sendMessage(message) {
			sendCalls += 1;
			if (options.sendThrows) throw new Error("synthetic send failure");
			sent.push({ role: "custom", ...message });
		},
	};
	cacheWarmExtension(pi);

	async function emit(name, event) {
		let result;
		for (const handler of handlers.get(name) ?? []) {
			const next = await handler(event, ctx);
			if (next !== undefined) result = next;
		}
		return result;
	}

	return {
		ctx,
		sent,
		notices,
		get abortCount() {
			return abortCount;
		},
		get sendCalls() {
			return sendCalls;
		},
		get unrefCalls() {
			return unrefCalls;
		},
		get clearIntervalCalls() {
			return clearIntervalCalls;
		},
		get hasActiveTimer() {
			return activeTimer !== undefined;
		},
		async start() {
			await emit("session_start", { type: "session_start", reason: "startup" });
		},
		async startAndEnable() {
			await emit("session_start", { type: "session_start", reason: "startup" });
			await commandHandler("on", ctx);
		},
		async command(args) {
			await commandHandler(args, ctx);
		},
		async seed(at) {
			await emit("input", { type: "input", text: "hello", source: "interactive" });
			await emit("before_agent_start", { type: "before_agent_start", prompt: "hello" });
			await emit("agent_start", { type: "agent_start" });
			await emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: at });
			await emit("message_start", { type: "message_start", message: { role: "user" } });
			await emit("message_end", {
				type: "message_end",
				message: { role: "assistant", usage: usage({ cacheWrite: 100 }) },
			});
			await emit("agent_settled", { type: "agent_settled" });
		},
		tickAt(value) {
			now = value;
			assert.ok(activeTimer);
			assert.ok(timerCallback);
			timerCallback();
		},
		async metrics() {
			await commandHandler("metrics", ctx);
			return notices.at(-1);
		},
		async status() {
			await commandHandler("status", ctx);
			return notices.at(-1);
		},
		emit,
		restore() {
			globalThis.setInterval = originalSetInterval;
			globalThis.clearInterval = originalClearInterval;
			Date.now = originalDateNow;
		},
	};
}
