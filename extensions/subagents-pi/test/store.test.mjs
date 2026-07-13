import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SubagentMetricsStore } from "../dist/store.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

function mockRegistry(records) {
	globalThis[MANAGER_KEY] = {
		getRecord: (id) => records.get(id),
		hasRunning: () => [...records.values()].some((r) => r.status === "running"),
	};
}

afterEach(() => {
	delete globalThis[MANAGER_KEY];
});

describe("SubagentMetricsStore", () => {
	it("lists rows for tracked agents", () => {
		const records = new Map([
			[
				"a1",
				{
					id: "a1",
					type: "Explore",
					description: "Find auth",
					status: "running",
					toolUses: 2,
					startedAt: Date.now() - 5000,
					lifetimeUsage: { input: 1, output: 100, cacheWrite: 0 },
					compactionCount: 0,
					invocation: { modelName: "haiku", thinking: "high" },
				},
			],
		]);
		mockRegistry(records);
		const store = new SubagentMetricsStore();
		store.markCompanionReady();
		store.trackId("a1");
		const rows = store.listRows();
		assert.equal(rows.length, 1);
		assert.equal(rows[0].model, "haiku");
		assert.equal(rows[0].thinking, "high");
		assert.equal(rows[0].context, "101");
	});

	it("reset clears tracked ids", () => {
		mockRegistry(new Map());
		const store = new SubagentMetricsStore();
		store.trackId("x");
		store.reset();
		assert.equal(store.visibleCount(), 0);
	});
});