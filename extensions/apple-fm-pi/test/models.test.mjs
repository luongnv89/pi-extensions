import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { buildProviderModels, STATIC_MODELS } = await import(
	`file://${join(extRoot, "src/models.ts")}`
);
const { loadAppleFmConfig } = await import(`file://${join(extRoot, "src/config.ts")}`);

test("STATIC_MODELS includes system and pcc", () => {
	assert.equal(STATIC_MODELS.length, 2);
	assert.deepEqual(
		STATIC_MODELS.map((m) => m.id),
		["system", "pcc"],
	);
});

test("buildProviderModels applies context window", () => {
	const cfg = loadAppleFmConfig({ APPLE_FM_PI_CONTEXT_WINDOW: "131072" });
	const models = buildProviderModels(cfg);
	assert.equal(models[0].contextWindow, 131_072);
	assert.equal(models[1].contextWindow, 131_072);
	const small = buildProviderModels(loadAppleFmConfig({}));
	assert.equal(small[0].contextWindow, 4096);
	assert.equal(small[1].contextWindow, 32_768);
	assert.equal(models[0].compat.maxTokensField, "max_tokens");
});