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

test("modelsFromCache prefers cache entries and falls back to defaults", () => {
	assert.deepEqual(
		modelsFromCache(null).map((info) => info.model),
		["grok-4.6", "grok-4.5", "grok-composer-2.5-fast", "grok-build"],
	);

	const cached = modelsFromCache({
		models: {
			"grok-4.6": {
				info: {
					model: "grok-4.6",
					name: "Grok 4.6",
					supports_reasoning_effort: true,
					reasoning_efforts: [{ id: "high", value: "high" }],
				},
			},
		},
	});
	assert.equal(cached.length, 1);
	assert.deepEqual(supportedThinkingLevels(cached[0]), ["high"]);
});
