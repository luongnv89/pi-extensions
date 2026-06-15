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

	it("estimates cost from model rates when usage.cost.total is zero", () => {
		const state = addAssistantMessageCost(createEmptySessionCostState(), usage({ input: 10_000, output: 5_000 }), {
			cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
		});
		const ctx = { model: { cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } } };
		assert.equal(getCostDisplayKind(state, ctx), "amount");
		assert.equal(formatCostSection(theme, state, ctx), "$0.105");
	});

	it("hides cost when active model has zero rates", () => {
		const state = addAssistantMessageCost(
			createEmptySessionCostState(),
			usage({ input: 100, output: 50 }),
			{ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
		);
		const ctx = { model: { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } };
		assert.equal(getCostDisplayKind(state, ctx), "unpriced");
		assert.equal(formatCostSection(theme, state, ctx), "");
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