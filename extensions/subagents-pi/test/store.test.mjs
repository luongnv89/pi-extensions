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

	it("uses runtime model and thinking for invocation-less inherited sessions", () => {
		const records = new Map([
			[
				"inherited",
				{
					id: "inherited",
					type: "general-purpose",
					description: "Use inherited defaults",
					status: "running",
					toolUses: 0,
					startedAt: Date.now() - 1000,
					lifetimeUsage: { input: 500, output: 50, cacheWrite: 0 },
					compactionCount: 0,
					session: {
						model: { provider: "openai-codex", id: "gpt-5.5" },
						thinkingLevel: "high",
						getSessionStats: () => ({
							tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, total: 125 },
							contextUsage: { tokens: 110, contextWindow: 1000, percent: 12 },
						}),
					},
				},
			],
		]);
		mockRegistry(records);
		const store = new SubagentMetricsStore();
		store.trackId("inherited");

		const [row] = store.listRows();
		assert.equal(row.model, "openai-codex/gpt-5.5");
		assert.equal(row.thinking, "high");
		assert.notEqual(row.model, row.type);
	});

	it("uses the current context estimate instead of cumulative session tokens", () => {
		const records = new Map([
			[
				"compacted",
				{
					id: "compacted",
					type: "Explore",
					description: "Compacted session",
					status: "running",
					toolUses: 1,
					startedAt: Date.now() - 1000,
					lifetimeUsage: { input: 20_000, output: 5_000, cacheWrite: 1_000 },
					compactionCount: 2,
					session: {
						getSessionStats: () => ({
							tokens: { input: 200, output: 40, cacheRead: 10, cacheWrite: 0, total: 250 },
							contextUsage: { tokens: 175, contextWindow: 2000, percent: 8 },
						}),
					},
				},
			],
		]);
		mockRegistry(records);
		const store = new SubagentMetricsStore();
		store.trackId("compacted");

		assert.equal(store.listRows()[0].context, "175 (8% · ⇊2)");
	});

	it("falls back to cumulative session tokens when the context estimate is unavailable", () => {
		const records = new Map([
			[
				"fallback",
				{
					id: "fallback",
					type: "Explore",
					description: "Unavailable estimate",
					status: "running",
					toolUses: 0,
					startedAt: Date.now() - 1000,
					lifetimeUsage: { input: 500, output: 100, cacheWrite: 0 },
					compactionCount: 0,
					session: {
						getSessionStats: () => ({
							tokens: { input: 200, output: 40, cacheWrite: 0, total: 240 },
							contextUsage: { tokens: null, contextWindow: 2000, percent: null },
						}),
					},
				},
			],
		]);
		mockRegistry(records);
		const store = new SubagentMetricsStore();
		store.trackId("fallback");

		assert.equal(store.listRows()[0].context, "240");
	});

	it("does not substitute the agent type for an unknown model", () => {
		const records = new Map([
			[
				"unknown",
				{
					id: "unknown",
					type: "general-purpose",
					description: "Unknown model",
					status: "queued",
					toolUses: 0,
					startedAt: Date.now(),
					lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
					compactionCount: 0,
				},
			],
		]);
		mockRegistry(records);
		const store = new SubagentMetricsStore();
		store.trackId("unknown");

		assert.equal(store.listRows()[0].model, "—");
	});

	it("hides old finished agents but shows them again when resumed", () => {
		const record = {
			id: "resumed",
			type: "general-purpose",
			description: "Resume later",
			status: "completed",
			toolUses: 1,
			startedAt: Date.now() - 60_000,
			completedAt: Date.now() - 31_000,
			lifetimeUsage: { input: 100, output: 20, cacheWrite: 0 },
			compactionCount: 0,
		};
		const records = new Map([[record.id, record]]);
		mockRegistry(records);
		const store = new SubagentMetricsStore();
		store.trackId(record.id);

		store.pruneMissing();
		assert.equal(store.listRows().length, 0);

		record.status = "running";
		record.startedAt = Date.now();
		assert.equal(store.listRows()[0].id, record.id);
	});

	it("reset clears tracked ids", () => {
		mockRegistry(new Map());
		const store = new SubagentMetricsStore();
		store.trackId("x");
		store.reset();
		assert.equal(store.visibleCount(), 0);
	});
});