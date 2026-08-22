import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBaseUrl, normalizeModels } from "./index.js";

test("normalizeBaseUrl trims configuration and trailing slashes", () => {
	assert.equal(normalizeBaseUrl(" http://localhost:20128/v1/// "), "http://localhost:20128/v1");
	assert.equal(normalizeBaseUrl(""), "http://localhost:20128/v1");
});

test("normalizeModels maps capabilities and removes invalid duplicates", () => {
	const models = normalizeModels({
		data: [
			{
				id: "alpha",
				context_length: 256000,
				max_completion_tokens: 8192,
				capabilities: {
					vision: true,
					reasoning: true,
					thinkingFormat: "zai",
					thinkingCanDisable: false,
				},
			},
			{ id: "alpha", capabilities: { reasoning: false } },
			{ id: "  beta  " },
			{ id: "" },
			{ id: null },
		],
	});

	assert.equal(models.length, 2);
	assert.deepEqual(models[0], {
		id: "alpha",
		name: "alpha",
		reasoning: true,
		thinkingLevelMap: { off: null },
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256000,
		maxTokens: 8192,
		compat: { thinkingFormat: "zai" },
	});
	assert.equal(models[1].id, "beta");
	assert.equal(models[1].contextWindow, 128000);
	assert.equal(models[1].maxTokens, 16384);
});
