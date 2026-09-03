import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const {
	buildProviderModels,
	defaultModelCatalog,
	modelsFromCache,
	modelSupportsReasoning,
	normalizeEffortToPiLevel,
	supportedThinkingLevels,
	thinkingLevelMapFor,
} = await import(`file://${join(extRoot, "src/models.ts")}`);

test("normalizeEffortToPiLevel maps grok effort ids", () => {
	assert.equal(normalizeEffortToPiLevel("low"), "low");
	assert.equal(normalizeEffortToPiLevel("HIGH"), "high");
	assert.equal(normalizeEffortToPiLevel("extra-high"), "xhigh");
	assert.equal(normalizeEffortToPiLevel("none"), "off");
	assert.equal(normalizeEffortToPiLevel("deep"), undefined);
});

test("thinkingLevelMapFor hides levels Grok does not advertise", () => {
	const map = thinkingLevelMapFor({
		model: "grok-4.5",
		supports_reasoning_effort: true,
		reasoning_efforts: [
			{ id: "high", value: "high" },
			{ id: "medium", value: "medium" },
			{ id: "low", value: "low" },
		],
	});

	assert.deepEqual(map, {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: null,
		max: null,
	});
	assert.deepEqual(supportedThinkingLevels({
		model: "grok-4.5",
		supports_reasoning_effort: true,
		reasoning_efforts: [
			{ id: "high", value: "high" },
			{ id: "medium", value: "medium" },
			{ id: "low", value: "low" },
		],
	}), ["low", "medium", "high"]);
});

test("thinkingLevelMapFor includes xhigh when Grok advertises it", () => {
	const map = thinkingLevelMapFor({
		model: "grok-4.6",
		supports_reasoning_effort: true,
		reasoning_efforts: [
			{ id: "xhigh", value: "xhigh" },
			{ id: "high", value: "high" },
			{ id: "medium", value: "medium" },
			{ id: "low", value: "low" },
		],
	});

	assert.equal(map.xhigh, "xhigh");
	assert.equal(map.off, null);
	assert.equal(map.max, null);
});

test("models without reasoning efforts stay non-reasoning", () => {
	const info = { model: "grok-composer-2.5-fast", name: "Composer 2.5" };
	assert.equal(modelSupportsReasoning(info), false);
	assert.equal(thinkingLevelMapFor(info), undefined);

	const [model] = buildProviderModels([info]);
	assert.equal(model.reasoning, false);
	assert.equal(model.thinkingLevelMap, undefined);
});

test("buildProviderModels exposes thinkingLevelMap for grok-4.6", () => {
	const grok46 = defaultModelCatalog().find((info) => info.model === "grok-4.6");
	assert.ok(grok46);
	const [model] = buildProviderModels([grok46]);
	assert.equal(model.reasoning, true);
	assert.deepEqual(model.thinkingLevelMap, {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: null,
	});
	assert.deepEqual(model.input, ["text", "image"]);
	assert.equal(model.maxTokens, 500_000);
});

test("buildProviderModels reads paid-model cost metadata", () => {
	const [model] = buildProviderModels([{
		model: "grok-paid",
		cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
	}]);

	assert.deepEqual(model.cost, {
		input: 3,
		output: 15,
		cacheRead: 0.3,
		cacheWrite: 3.75,
	});
});

test("buildProviderModels accepts flat cost and pricing metadata aliases", () => {
	const [camelCase, snakeCase] = buildProviderModels([
		{
			model: "grok-flat-cost",
			cost: { input: 4, output: 16, cacheRead: 0.4, cacheWrite: 4 },
		},
		{
			model: "grok-flat-pricing",
			pricing: { input: 5, output: 20, cache_read: 0.5, cache_write: 5 },
		},
	]);

	assert.deepEqual(camelCase.cost, {
		input: 4,
		output: 16,
		cacheRead: 0.4,
		cacheWrite: 4,
	});
	assert.deepEqual(snakeCase.cost, {
		input: 5,
		output: 20,
		cacheRead: 0.5,
		cacheWrite: 5,
	});
});

test("buildProviderModels defaults missing or malformed cost metadata to zero", () => {
	const [missing, malformed] = buildProviderModels([
		{ model: "grok-missing-cost" },
		{
			model: "grok-malformed-cost",
			cost: { input: -1, output: "paid", cache: { read: Number.NaN, write: null } },
		},
	]);

	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	assert.deepEqual(missing.cost, zero);
	assert.deepEqual(malformed.cost, zero);
});

test("modelsFromCache prefers cache entries and falls back to verified defaults", () => {
	assert.deepEqual(
		modelsFromCache(null).map((info) => info.model),
		["grok-4.6", "grok-4.5"],
	);

	const cache = {
		models: {
			"grok-4.6": {
				info: {
					model: "grok-4.6",
					name: "Grok 4.6",
					context_window: 500_000,
					supports_reasoning_effort: true,
					reasoning_efforts: [{ id: "high", value: "high" }],
				},
			},
		},
	};
	const cached = modelsFromCache(cache);
	assert.equal(cached.length, 1);
	assert.deepEqual(supportedThinkingLevels(cached[0]), ["high"]);
});

test("modelsFromCache enriches environment-selected ids from cached metadata", () => {
	const cache = {
		models: {
			"grok-4.6": {
				info: {
					model: "grok-4.6",
					context_window: 500_000,
					supports_reasoning_effort: true,
					reasoning_efforts: [
						{ id: "high", value: "high" },
						{ id: "low", value: "low" },
					],
				},
			},
		},
	};

	const selected = modelsFromCache(cache, ["unknown-model", "grok-4.6"]);
	assert.deepEqual(selected.map((info) => info.model), ["unknown-model", "grok-4.6"]);
	assert.deepEqual(selected[0], { model: "unknown-model" });
	assert.equal(selected[1].context_window, 500_000);
	assert.deepEqual(supportedThinkingLevels(selected[1]), ["low", "high"]);
});
