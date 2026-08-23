import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const {
	agyBin,
	checkAgyStatus,
	setupGuidance,
	streamAgy,
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
