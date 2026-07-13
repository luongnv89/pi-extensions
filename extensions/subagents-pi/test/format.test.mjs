import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	computeOutputTps,
	formatCompactTokenCount,
	formatContextLabel,
	formatTps,
	getLifetimeTotal,
} from "../dist/format.js";

describe("subagents-pi format", () => {
	it("sums lifetime usage", () => {
		assert.equal(getLifetimeTotal({ input: 10, output: 20, cacheWrite: 5 }), 35);
	});

	it("formats compact token counts", () => {
		assert.equal(formatCompactTokenCount(900), "900");
		assert.equal(formatCompactTokenCount(12_400), "12.4k");
	});

	it("formats context with percent and compaction", () => {
		assert.equal(formatContextLabel(33_800, 62, 2), "33.8k (62% · ⇊2)");
	});

	it("computes output TPS", () => {
		const tps = computeOutputTps(100, 2000);
		assert.ok(tps !== undefined && Math.abs(tps - 50) < 0.01);
	});

	it("formats TPS placeholder", () => {
		assert.equal(formatTps(undefined), "—");
		assert.equal(formatTps(42.3), "42.3");
	});
});