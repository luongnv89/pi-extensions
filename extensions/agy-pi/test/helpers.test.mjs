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
	DEFAULT_TURN_TIMEOUT_MS,
	discoverModels,
	parseAgyModelsOutput,
	resolveTurnTimeoutMs,
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

test("resolveTurnTimeoutMs honors a positive finite timeout and falls back to the internal default", () => {
	assert.equal(DEFAULT_TURN_TIMEOUT_MS, 180_000);
	assert.equal(resolveTurnTimeoutMs(5_000), 5_000);
	assert.equal(resolveTurnTimeoutMs(0), DEFAULT_TURN_TIMEOUT_MS);
	assert.equal(resolveTurnTimeoutMs(-1), DEFAULT_TURN_TIMEOUT_MS);
	assert.equal(resolveTurnTimeoutMs(NaN), DEFAULT_TURN_TIMEOUT_MS);
	assert.equal(resolveTurnTimeoutMs(Infinity), DEFAULT_TURN_TIMEOUT_MS);
	assert.equal(resolveTurnTimeoutMs(undefined), DEFAULT_TURN_TIMEOUT_MS);
	assert.equal(resolveTurnTimeoutMs("100"), DEFAULT_TURN_TIMEOUT_MS);
});

function fakeSignal() {
	return {
		aborted: false,
		_adds: 0,
		_removes: 0,
		addEventListener() {
			this._adds += 1;
		},
		removeEventListener() {
			this._removes += 1;
		},
	};
}

function streamFromFakeAgy(script, options) {
	return withFakeAgy(script, () =>
		collectEvents(
			streamAgy(fakeModel(), { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, options),
		),
	);
}

test("streamAgy emits each chunk once on a stable content index (two-chunk response)", async () => {
	const events = await streamFromFakeAgy(
		`process.stdout.write("Hello "); setTimeout(() => { process.stdout.write("world"); }, 40);`,
	);

	assert.deepEqual(
		events.map((event) => event.type),
		["start", "text_start", "text_delta", "text_delta", "text_end", "done"],
	);
	for (const event of events) {
		if (event.type.startsWith("text_")) {
			assert.equal(event.contentIndex, 0, "content index must stay stable");
		}
	}
	const deltas = events
		.filter((event) => event.type === "text_delta")
		.map((event) => event.delta);
	assert.equal(deltas.join(""), "Hello world");
	const done = events.at(-1);
	assert.equal(done.type, "done");
	assert.equal(done.message.stopReason, "stop");
	const blocks = done.message.content.filter((block) => block.type === "text");
	assert.equal(blocks.length, 1, "text must appear exactly once in the final message");
	assert.equal(blocks[0].text, "Hello world");
	const fullText = blocks[0].text;
	assert.equal(
		(fullText.match(/Hello world/g) ?? []).length,
		1,
		"the response text must not be re-emitted",
	);
});

test("streamAgy surfaces a nonzero exit as an error carrying captured stderr", async () => {
	const events = await streamFromFakeAgy(
		`process.stderr.write("something broke\\n"); process.exit(1);`,
	);

	assert.deepEqual(
		events.map((event) => event.type),
		["start", "error"],
	);
	const error = events.at(-1);
	if (error?.type !== "error") return;
	assert.equal(error.reason, "error");
	assert.equal(error.error.stopReason, "error");
	assert.match(error.error.errorMessage ?? "", /something broke/);
	const text = error.error.content.find((block) => block.type === "text")?.text ?? "";
	assert.ok(text.includes("something broke"));
	assert.ok(!text.includes("No response from agy."));
});

test("streamAgy reports a timeout as an error and clears the timer", async () => {
	const signal = fakeSignal();
	const events = await streamFromFakeAgy(
		`setInterval(() => {}, 1000);`,
		{ timeoutMs: 300, signal },
	);

	assert.equal(signal._adds, 1, "abort listener must be attached");
	assert.equal(signal._removes, 1, "abort listener must be detached after the turn");
	assert.deepEqual(events.map((event) => event.type), ["start", "error"]);
	const error = events.at(-1);
	if (error?.type !== "error") return;
	assert.equal(error.error.stopReason, "error");
	assert.match(error.error.errorMessage ?? "", /agy timed out after 300ms/);
	const text = error.error.content.find((block) => block.type === "text")?.text ?? "";
	assert.ok(text.includes("timed out after 300ms"));
	assert.ok(!text.includes("No response from agy."));
});

test("streamAgy reports a mid-flight abort as the aborted stop reason", async () => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 100);
	let events;
	try {
		events = await streamFromFakeAgy(
			`process.stdout.write("partial"); setInterval(() => {}, 1000);`,
			{ signal: controller.signal },
		);
	} finally {
		clearTimeout(timer);
	}

	const error = events.at(-1);
	if (error?.type !== "error") return;
	assert.equal(error.reason, "aborted");
	assert.equal(error.error.stopReason, "aborted");
	assert.equal(error.error.errorMessage, "Request was aborted");
});

test("streamAgy keeps a genuinely empty successful run distinct from failures", async () => {
	const events = await streamFromFakeAgy(`process.exit(0);`);

	assert.deepEqual(
		events.map((event) => event.type),
		["start", "text_start", "text_delta", "text_end", "done"],
	);
	const done = events.at(-1);
	if (done?.type !== "done") return;
	assert.equal(done.reason, "stop");
	assert.equal(done.message.stopReason, "stop");
	const text = done.message.content.find((block) => block.type === "text")?.text ?? "";
	assert.equal(text, "No response from agy.");
});

test("streamAgy detaches the abort listener on a successful turn without a signal", async () => {
	const signal = fakeSignal();
	const events = await streamFromFakeAgy(`process.exit(0);`, { signal });
	assert.equal(signal._adds, 1);
	assert.equal(signal._removes, 1, "abort listener must be detached on success");
	assert.deepEqual(events.map((event) => event.type), ["start", "text_start", "text_delta", "text_end", "done"]);
});

test("streamAgy emits actionable setup guidance and leaves no stranded timer when the binary is missing", async () => {
	const previousBin = process.env.AGY_PI_BIN;
	process.env.AGY_PI_BIN = missingBin();
	try {
		const events = await collectEvents(
			streamAgy(fakeModel(), { messages: [{ role: "user", content: "hi", timestamp: 1 }] }),
		);
		assert.deepEqual(events.map((event) => event.type), ["start", "error"]);
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
