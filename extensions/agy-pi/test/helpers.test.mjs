import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const {
	agyBin,
	agySlugForLevel,
	BUNDLED_MODELS,
	checkAgyStatus,
	discoverModels,
	parseAgyModelsOutput,
	setupGuidance,
	streamAgy,
	toBaseModels,
} = await import(`file://${join(extRoot, "src/index.ts")}`);

// process.env values are coerced to strings, so `process.env.X = undefined`
// sets it to the literal string "undefined" instead of clearing it. Restore
// via delete when the original value was unset.
function restoreEnv(key, value) {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

function withFakeAgy(script, run) {
	const dir = mkdtempSync(join(tmpdir(), "agy-pi-fake-bin-"));
	const binPath = join(dir, "agy-fake.js");
	writeFileSync(binPath, `#!/usr/bin/env node\n${script}`, "utf8");
	chmodSync(binPath, 0o755);

	const previousBin = process.env.AGY_PI_BIN;
	process.env.AGY_PI_BIN = binPath;
	return Promise.resolve()
		.then(run)
		.finally(() => {
			restoreEnv("AGY_PI_BIN", previousBin);
			rmSync(dir, { recursive: true, force: true });
		});
}

function missingBin() {
	return join(tmpdir(), `agy-pi-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function fakeModel() {
	return {
		id: "gemini-3.6-flash-high",
		name: "Gemini 3.6 Flash",
		api: "agy-runner",
		provider: "agy",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 8_192,
	};
}

async function collectEvents(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

test("agyBin resolves the default binary and honors AGY_PI_BIN", () => {
	const previousBin = process.env.AGY_PI_BIN;
	try {
		delete process.env.AGY_PI_BIN;
		assert.equal(agyBin(), "agy");
		process.env.AGY_PI_BIN = "/usr/local/bin/agy-custom";
		assert.equal(agyBin(), "/usr/local/bin/agy-custom");
	} finally {
		restoreEnv("AGY_PI_BIN", previousBin);
	}
});

test("setupGuidance names agy, the install command, and reload step", () => {
	const guidance = setupGuidance("spawn agy ENOENT");
	assert.match(guidance, /agy-pi could not use the local agy CLI/);
	assert.match(guidance, /Reason: spawn agy ENOENT/);
	assert.match(guidance, /pip install agy-cli/);
	assert.match(guidance, /agy --version/);
	assert.match(guidance, /reload Pi/);
});

test("checkAgyStatus reports ok for a working binary", async () => {
	await withFakeAgy(`process.stdout.write("agy 1.2.3\\n");`, async () => {
		const status = await checkAgyStatus();
		assert.equal(status.ok, true);
		assert.equal(status.summary, "agy 1.2.3");
	});
});

test("checkAgyStatus reports unavailable when the binary is missing", async () => {
	const previousBin = process.env.AGY_PI_BIN;
	process.env.AGY_PI_BIN = missingBin();
	try {
		const status = await checkAgyStatus();
		assert.equal(status.ok, false);
		assert.equal(status.summary, "agy CLI is unavailable");
		assert.ok(status.detail);
	} finally {
		restoreEnv("AGY_PI_BIN", previousBin);
	}
});

test("checkAgyStatus reports unusable when --version exits nonzero", async () => {
	await withFakeAgy(`process.stderr.write("boom\\n"); process.exit(3);`, async () => {
		const status = await checkAgyStatus();
		assert.equal(status.ok, false);
		assert.equal(status.summary, "agy CLI is unusable");
		assert.equal(status.detail, "boom");
	});
});

function withClearedModels(run) {
	const previousModels = process.env.AGY_PI_MODELS;
	delete process.env.AGY_PI_MODELS;
	return Promise.resolve()
		.then(run)
		.finally(() => restoreEnv("AGY_PI_MODELS", previousModels));
}

const TAB_MODELS_SCRIPT = `
if (process.argv[2] === "models") {
  process.stdout.write([
    "gemini-3.8-flash-high\\tGemini 3.8 Flash (High)",
    "gemini-3.8-flash-medium\\tGemini 3.8 Flash (Medium)",
    "gemini-3.8-flash-low\\tGemini 3.8 Flash (Low)",
    "gemini-3.7-flash-high\\tGemini 3.7 Flash (High)",
    "claude-sonnet-4-6\\tClaude Sonnet 4.6 (Thinking)",
    "gpt-oss-120b-medium\\tGPT-OSS 120B (Medium)",
    "",
    "extra-id\\tExtra Name\\textra-column",
  ].join("\\n") + "\\n");
} else {
  process.stdout.write("agy 1.1.25\\n");
}
`;

test("parseAgyModelsOutput splits id and display name on the first tab", () => {
	const parsed = parseAgyModelsOutput(
		[
			"gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
			"",
			"  gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\tignored-column  ",
			"bare-id-only",
			"\tmissing-id",
		].join("\n"),
	);
	assert.deepEqual(parsed, [
		{ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
		{ id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
		{ id: "bare-id-only" },
	]);
});

test("toBaseModels collapses effort variants and uses the CLI display name", () => {
	const models = toBaseModels([
		{ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
		{ id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
		{ id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
		{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
	]);
	assert.equal(models.length, 2);
	assert.equal(models[0].id, "gemini-3.8-flash");
	assert.equal(models[0].name, "Gemini 3.8 Flash");
	assert.deepEqual(new Set(models[0].effortLevels), new Set(["high", "medium", "low"]));
	assert.equal(models[1].id, "claude-sonnet-4-6");
	assert.equal(models[1].name, "Claude Sonnet 4.6 (Thinking)");
	assert.equal(models[1].effortLevels, undefined);
});

test("bundled fallback names only models the CLI currently offers", () => {
	const ids = BUNDLED_MODELS.map((model) => model.id);
	assert.equal(
		ids.some((id) => id.startsWith("gemini-3.5-flash")),
		false,
		"stale gemini-3.5-flash variants must not remain in the fallback",
	);
	assert.ok(
		ids.includes("gemini-3.8-flash-high") &&
			ids.includes("gemini-3.8-flash-medium") &&
			ids.includes("gemini-3.8-flash-low"),
		"current gemini-3.8-flash family must be in the fallback",
	);
	const families = toBaseModels(ids).map((model) => model.id);
	assert.ok(families.includes("gemini-3.8-flash"));
	assert.ok(families.includes("gemini-3.7-flash"));
	assert.ok(families.includes("gemini-3.6-flash"));
	assert.ok(families.includes("gemini-3.1-pro"));
	assert.ok(families.includes("claude-sonnet-4-6"));
	assert.ok(families.includes("claude-opus-4-6-thinking"));
	assert.ok(families.includes("gpt-oss-120b"));
	assert.equal(families.some((id) => id.includes("gemini-3.5")), false);
	const flash = toBaseModels(ids).find((model) => model.id === "gemini-3.8-flash");
	assert.equal(flash?.name, "Gemini 3.8 Flash");
	assert.deepEqual(new Set(flash?.effortLevels), new Set(["high", "medium", "low"]));
});

test("discoverModels splits tab-separated agy models lines into clean ids", async () => {
	await withClearedModels(() =>
		withFakeAgy(TAB_MODELS_SCRIPT, async () => {
			const { models, error } = await discoverModels({ forceDiscovery: true });
			assert.equal(error, undefined);
			assert.ok(models.length > 0);
			for (const model of models) {
				assert.equal(model.id.includes("\t"), false, `id still contains a tab: ${JSON.stringify(model.id)}`);
				assert.doesNotMatch(model.id, /\s/, `id still contains whitespace: ${JSON.stringify(model.id)}`);
				assert.doesNotMatch(model.id, /Gemini|Claude|GPT-OSS|Flash|Thinking/);
			}
			const flash = models.find((model) => model.id === "gemini-3.8-flash");
			assert.ok(flash, `expected collapsed gemini-3.8-flash, got ${models.map((m) => m.id).join(",")}`);
			assert.deepEqual(new Set(flash.effortLevels), new Set(["high", "medium", "low"]));
			assert.equal(agySlugForLevel("gemini-3.8-flash", "high"), "gemini-3.8-flash-high");
			assert.equal(agySlugForLevel("gemini-3.8-flash", "low"), "gemini-3.8-flash-low");
			const extra = models.find((model) => model.id === "extra-id");
			assert.ok(extra, "extra columns must not leak into the model id");
			assert.equal(extra.id.includes("extra-column"), false);
		}),
	);
});

test("streamAgy emits actionable setup guidance instead of a bare empty response when the binary is missing", async () => {
	const previousBin = process.env.AGY_PI_BIN;
	process.env.AGY_PI_BIN = missingBin();
	try {
		const events = await collectEvents(
			streamAgy(fakeModel(), { messages: [{ role: "user", content: "hi", timestamp: 1 }] }),
		);

		assert.deepEqual(
			events.map((event) => event.type),
			["start", "error"],
		);
		const error = events.at(-1);
		if (error?.type !== "error") return;
		const text = error.error.content.find((block) => block.type === "text")?.text ?? "";
		assert.match(text, /agy-pi could not use the local agy CLI/);
		assert.match(text, /failed to launch/);
		assert.ok(!text.includes("No response from agy."));
	} finally {
		restoreEnv("AGY_PI_BIN", previousBin);
	}
});
