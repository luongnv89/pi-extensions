import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	CODING_TOOLS,
	defaultConfig,
	defaultStats,
	formatModelSpec,
	modelResolves,
	normalizeConfig,
	normalizeStats,
	parseBoolean,
	parseModelSpec,
	parseThinkingLevel,
	parseToolMode,
	READONLY_TOOLS,
	resolveSidekickModel,
	toolsForMode,
} from "../dist/config.js";

describe("parseModelSpec", () => {
	it("splits on the first slash so provider-qualified ids survive", () => {
		assert.deepEqual(parseModelSpec("groq/openai/gpt-oss-20b"), {
			provider: "groq",
			modelId: "openai/gpt-oss-20b",
		});
	});

	it("rejects specs without a usable provider and model", () => {
		for (const bad of ["", "   ", "noslash", "/leading", "trailing/"]) {
			assert.equal(parseModelSpec(bad), undefined, bad);
		}
	});
});

describe("tool modes", () => {
	it("defaults to coding, so the sidekick can apply changes itself", () => {
		assert.equal(defaultConfig().toolMode, "coding");
		assert.deepEqual(toolsForMode("coding"), [...CODING_TOOLS]);
	});

	it("still offers a read-only mode that cannot write or run commands", () => {
		assert.deepEqual(toolsForMode("readonly"), [...READONLY_TOOLS]);
		assert.equal(parseToolMode("readonly"), "readonly");
	});

	it("adds edit, write, and bash only in coding mode", () => {
		assert.deepEqual(toolsForMode("coding"), [...CODING_TOOLS]);
		for (const tool of ["edit", "write", "bash"]) {
			assert.ok(!READONLY_TOOLS.includes(tool), `${tool} must not be read-only`);
		}
	});

	it("rejects unknown modes", () => {
		assert.equal(parseToolMode("rw"), undefined);
	});
});

describe("parsers", () => {
	it("accepts every thinking level Pi supports, including off", () => {
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
			assert.equal(parseThinkingLevel(level), level);
		}
		assert.equal(parseThinkingLevel("ultra"), undefined);
	});

	it("reads on/off style booleans", () => {
		assert.equal(parseBoolean("on"), true);
		assert.equal(parseBoolean("OFF"), false);
		assert.equal(parseBoolean("maybe"), undefined);
	});
});

describe("normalizeConfig", () => {
	const fallback = defaultConfig();

	it("keeps fallbacks for missing fields", () => {
		assert.deepEqual(normalizeConfig({}, fallback), { ...fallback, sidekickUpgrade: undefined, frontier: undefined });
	});

	it("restores a stored sidekick, upgrade, and frontier", () => {
		const stored = {
			sidekick: { provider: "groq", modelId: "llama-3.1-8b-instant" },
			sidekickUpgrade: { provider: "openai-codex", modelId: "gpt-5.4-mini" },
			frontier: { provider: "openai-codex", modelId: "gpt-5.6-sol" },
			routing: true,
			toolMode: "coding",
		};
		const config = normalizeConfig(stored, fallback);
		assert.equal(formatModelSpec(config.sidekick), "groq/llama-3.1-8b-instant");
		assert.equal(formatModelSpec(config.sidekickUpgrade), "openai-codex/gpt-5.4-mini");
		assert.equal(formatModelSpec(config.frontier), "openai-codex/gpt-5.6-sol");
		assert.equal(config.routing, true);
		assert.equal(config.toolMode, "coding");
	});

	it("treats an explicit null as a cleared optional model", () => {
		const withUpgrade = { ...fallback, sidekickUpgrade: { provider: "a", modelId: "b" } };
		const cleared = normalizeConfig({ sidekickUpgrade: null }, withUpgrade);
		assert.equal(cleared.sidekickUpgrade, undefined);
	});

	it("ignores nonsense numbers", () => {
		const config = normalizeConfig({ maxDelegations: -3, timeoutMs: 0 }, fallback);
		assert.equal(config.maxDelegations, fallback.maxDelegations);
		assert.equal(config.timeoutMs, fallback.timeoutMs);
	});
});

describe("normalizeStats", () => {
	it("keeps restored counters and drops invalid ones", () => {
		const restored = normalizeStats(
			{ delegations: 7, failures: -1, tokens: { input: 10, total: 10 }, sidekickCost: 0.5 },
			defaultStats(),
		);
		assert.equal(restored.delegations, 7);
		assert.equal(restored.failures, 0);
		assert.equal(restored.tokens.input, 10);
		assert.equal(restored.sidekickCost, 0.5);
	});
});

describe("resolveSidekickModel", () => {
	it("picks the first candidate the registry can resolve", () => {
		const registry = {
			find: (provider, modelId) => (provider === "groq" && modelId === "llama-3.1-8b-instant" ? {} : undefined),
		};
		assert.deepEqual(resolveSidekickModel(registry), { provider: "groq", modelId: "llama-3.1-8b-instant" });
	});

	it("falls back to the first available model when no candidate resolves", () => {
		const registry = {
			find: () => undefined,
			getAvailable: () => [{ provider: "xai", id: "grok-4" }],
		};
		assert.deepEqual(resolveSidekickModel(registry), { provider: "xai", modelId: "grok-4" });
	});

	it("survives a registry that throws", () => {
		const registry = {
			find: () => {
				throw new Error("boom");
			},
		};
		assert.equal(modelResolves(registry, { provider: "a", modelId: "b" }), false);
		assert.equal(resolveSidekickModel(registry), undefined);
	});
});
