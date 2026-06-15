import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	addAssistantMessageCost,
	createEmptySessionCostState,
	formatCostSection,
	formatCostUsd,
	getCostDisplayKind,
} from "../dist/cost.js";

const theme = {
	fg: (_color, text) => text,
};

function usage(partial = {}) {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		...partial,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
			...(partial.cost ?? {}),
		},
	};
}

describe("session cost estimation", () => {
	it("accumulates assistant usage cost across turns", () => {
		let state = createEmptySessionCostState();
		state = addAssistantMessageCost(state, usage({ input: 1000, cost: { total: 0.0025, input: 0.0025, output: 0, cacheRead: 0, cacheWrite: 0 } }));
		state = addAssistantMessageCost(state, usage({ output: 500, cost: { total: 0.001, input: 0, output: 0.001, cacheRead: 0, cacheWrite: 0 } }));

		assert.equal(state.totalUsd, 0.0035);
		assert.equal(state.hasPricedTurn, true);
	});

	it("formats small and large USD amounts", () => {
		assert.equal(formatCostUsd(0), "$0.00");
		assert.equal(formatCostUsd(0.0042), "$0.0042");
		assert.equal(formatCostUsd(0.42), "$0.420");
		assert.equal(formatCostUsd(12.3), "$12.30");
	});

	it("shows unknown pricing when tokens exist but cost is zero", () => {
		const state = addAssistantMessageCost(createEmptySessionCostState(), usage({ input: 10, output: 5 }));
		const ctx = { model: { cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } };
		assert.equal(getCostDisplayKind(state, ctx), "unknown");
		assert.equal(formatCostSection(theme, state, ctx), "cost ?");
	});

	it("shows cost n/a when active model has zero rates", () => {
		const state = createEmptySessionCostState();
		const ctx = { model: { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } };
		assert.equal(getCostDisplayKind(state, ctx), "unpriced");
		assert.equal(formatCostSection(theme, state, ctx), "cost n/a");
	});

	it("shows accumulated total when priced turns exist", () => {
		const state = addAssistantMessageCost(
			createEmptySessionCostState(),
			usage({ cost: { total: 0.08, input: 0.05, output: 0.03, cacheRead: 0, cacheWrite: 0 } }),
		);
		const ctx = { model: { cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } } };
		assert.equal(formatCostSection(theme, state, ctx), "$0.080");
	});
});