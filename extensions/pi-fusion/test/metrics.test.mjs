import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultStats } from "../dist/config.js";
import {
	addTokens,
	counterfactualCost,
	diffTokens,
	formatSavings,
	formatTokens,
	formatUsd,
	savingsSummary,
} from "../dist/metrics.js";

const cheapModel = { api: "openai-completions", cost: { input: 0.05, output: 0.08, cacheRead: 0, cacheWrite: 0 } };

describe("diffTokens", () => {
	it("returns the delta between two cumulative snapshots", () => {
		const delta = diffTokens(
			{ input: 100, output: 20, cacheRead: 5, cacheWrite: 1, total: 126 },
			{ input: 40, output: 8, cacheRead: 5, cacheWrite: 0, total: 53 },
		);
		assert.deepEqual(delta, { input: 60, output: 12, cacheRead: 0, cacheWrite: 1, total: 73 });
	});

	it("clamps at zero when a session resets under it", () => {
		const delta = diffTokens({ input: 1, total: 1 }, { input: 500, total: 500 });
		assert.equal(delta.input, 0);
		assert.equal(delta.total, 0);
	});

	it("treats missing fields as zero", () => {
		assert.deepEqual(diffTokens({}, {}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
	});
});

describe("addTokens", () => {
	it("accumulates across delegations", () => {
		const a = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 };
		assert.deepEqual(addTokens(a, a), { input: 2, output: 4, cacheRead: 6, cacheWrite: 8, total: 20 });
	});
});

describe("counterfactualCost", () => {
	it("prices the sidekick's tokens at the main model's rates", () => {
		const cost = counterfactualCost(cheapModel, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 });
		assert.ok(cost !== undefined);
		assert.ok(Math.abs(cost - 0.05) < 1e-9, `expected ~0.05, got ${cost}`);
	});

	it("returns undefined for a model with no usable price table", () => {
		assert.equal(counterfactualCost(undefined, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }), undefined);
		assert.equal(counterfactualCost({ cost: { input: "free" } }, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }), undefined);
	});
});

describe("savingsSummary", () => {
	it("reports the gap between actual and counterfactual spend", () => {
		const stats = { ...defaultStats(), delegations: 2, sidekickCost: 1, counterfactualCost: 4 };
		const summary = savingsSummary(stats);
		assert.equal(summary.saved, 3);
		assert.equal(summary.percent, 75);
	});

	it("leaves the percentage undefined when there is nothing to compare against", () => {
		const summary = savingsSummary({ ...defaultStats(), sidekickCost: 0.2 });
		assert.equal(summary.percent, undefined);
		assert.match(formatSavings({ ...defaultStats(), sidekickCost: 0.2 }), /sidekick spend/);
	});

	it("can report a negative saving rather than hiding it", () => {
		const summary = savingsSummary({ ...defaultStats(), sidekickCost: 5, counterfactualCost: 2 });
		assert.equal(summary.saved, -3);
		assert.ok(summary.percent < 0);
	});
});

describe("formatting", () => {
	it("keeps sub-cent amounts visible", () => {
		assert.equal(formatUsd(0.0004), "$0.0004");
		assert.equal(formatUsd(1.5), "$1.50");
		assert.equal(formatUsd(-0.25), "-$0.25");
		assert.equal(formatUsd(Number.NaN), "$0.00");
	});

	it("abbreviates token counts", () => {
		assert.equal(formatTokens(950), "950");
		assert.equal(formatTokens(1500), "1.5k");
		assert.equal(formatTokens(2_400_000), "2.4M");
		assert.equal(formatTokens(-1), "0");
	});
});
