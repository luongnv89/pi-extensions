import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideRoute, ROUTER_THRESHOLDS } from "../dist/router.js";

const base = {
	delegations: 4,
	consecutiveFailures: 0,
	cleanDelegations: 0,
	sidekickUpgraded: false,
	mainEscalated: false,
	hasUpgrade: true,
	hasFrontier: true,
};

describe("decideRoute", () => {
	it("holds when nothing is struggling", () => {
		assert.equal(decideRoute(base).action, "hold");
	});

	it("holds below the failure threshold", () => {
		const signals = { ...base, consecutiveFailures: ROUTER_THRESHOLDS.escalateFailures - 1 };
		assert.equal(decideRoute(signals).action, "hold");
	});

	it("upgrades the sidekick before touching the main agent", () => {
		const signals = { ...base, consecutiveFailures: ROUTER_THRESHOLDS.escalateFailures };
		const decision = decideRoute(signals);
		assert.equal(decision.action, "upgrade_sidekick");
		assert.match(decision.reason, /sidekick/);
	});

	it("escalates the main agent once the sidekick is already upgraded", () => {
		const signals = { ...base, consecutiveFailures: 3, sidekickUpgraded: true };
		assert.equal(decideRoute(signals).action, "escalate_main");
	});

	it("escalates straight to the main agent when no upgrade model is configured", () => {
		const signals = { ...base, consecutiveFailures: 2, hasUpgrade: false };
		assert.equal(decideRoute(signals).action, "escalate_main");
	});

	it("holds when struggling with no escalation target configured", () => {
		const signals = { ...base, consecutiveFailures: 5, hasUpgrade: false, hasFrontier: false };
		const decision = decideRoute(signals);
		assert.equal(decision.action, "hold");
		assert.match(decision.reason, /no escalation target/);
	});

	it("does not escalate the main agent twice", () => {
		const signals = { ...base, consecutiveFailures: 4, sidekickUpgraded: true, mainEscalated: true };
		assert.equal(decideRoute(signals).action, "hold");
	});

	it("downgrades after enough clean delegations on the frontier model", () => {
		const signals = {
			...base,
			mainEscalated: true,
			cleanDelegations: ROUTER_THRESHOLDS.downgradeCleanDelegations,
		};
		assert.equal(decideRoute(signals).action, "downgrade_main");
	});

	it("keeps the frontier model until the clean streak is long enough", () => {
		const signals = {
			...base,
			mainEscalated: true,
			cleanDelegations: ROUTER_THRESHOLDS.downgradeCleanDelegations - 1,
		};
		assert.equal(decideRoute(signals).action, "hold");
	});

	it("never downgrades a main agent that was never escalated", () => {
		const signals = { ...base, cleanDelegations: 99 };
		assert.equal(decideRoute(signals).action, "hold");
	});
});
