import assert from "node:assert/strict";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

register("./resolve-ts-imports.mjs", import.meta.url);

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { streamGrokCli } = await import(`file://${join(extRoot, "src/bridge.ts")}`);

const FAKE_CLI = `
import { dirname } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

const promptFlag = process.argv.indexOf("--prompt-file");
const promptPath = process.argv[promptFlag + 1];
const prompt = readFileSync(promptPath, "utf8");
writeFileSync(
	process.env.GROK_PI_TEST_CONTROL,
	JSON.stringify({ promptPath, prompt }),
	"utf8",
);

switch (process.env.GROK_PI_TEST_MODE) {
	case "success":
		process.stdout.write(JSON.stringify({ text: "fake success", usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } }));
		break;
	case "failure":
		process.stderr.write("fake CLI failure");
		process.exitCode = 7;
		break;
	case "timeout":
	case "abort":
		setTimeout(() => process.exit(0), 5_000);
		break;
	default:
		process.exitCode = 99;
}
`;

function restoreEnv(key, value) {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

function fakeModel() {
	return {
		id: "grok-test",
		name: "Grok test",
		api: "grok-cli-runner",
		provider: "grok-cli",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

function testContext(input) {
	return {
		systemPrompt: "Lifecycle test system prompt",
		messages: [{ role: "user", content: input, timestamp: 1 }],
		tools: [],
	};
}

async function collectEvents(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

function wait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForControl(controlPath, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			return JSON.parse(readFileSync(controlPath, "utf8"));
		} catch {
			await wait(10);
		}
	}
	throw new Error(`fake CLI did not read the prompt within ${timeoutMs}ms`);
}

async function collectWithWatchdog(eventsPromise, timeoutMs = 3_000) {
	let timer;
	try {
		return await Promise.race([
			eventsPromise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`stream did not finish within ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function withFakeCli(mode, run) {
	const dir = mkdtempSync(join(tmpdir(), "grok-pi-lifecycle-"));
	const binPath = join(dir, "grok-fake.mjs");
	const controlPath = join(dir, "control.json");
	writeFileSync(binPath, `#!/usr/bin/env node\n${FAKE_CLI}`, "utf8");
	chmodSync(binPath, 0o755);

	const previousBin = process.env.GROK_PI_BIN;
	const previousControl = process.env.GROK_PI_TEST_CONTROL;
	const previousMode = process.env.GROK_PI_TEST_MODE;
	const previousTimeout = process.env.GROK_PI_TIMEOUT_MS;
	process.env.GROK_PI_BIN = binPath;
	process.env.GROK_PI_TEST_CONTROL = controlPath;
	process.env.GROK_PI_TEST_MODE = mode;
	if (mode === "timeout") process.env.GROK_PI_TIMEOUT_MS = "250";
	else delete process.env.GROK_PI_TIMEOUT_MS;

	try {
		return await run({ controlPath });
	} finally {
		restoreEnv("GROK_PI_BIN", previousBin);
		restoreEnv("GROK_PI_TEST_CONTROL", previousControl);
		restoreEnv("GROK_PI_TEST_MODE", previousMode);
		restoreEnv("GROK_PI_TIMEOUT_MS", previousTimeout);
		rmSync(dir, { recursive: true, force: true });
	}
}

function assertPromptWasReadAndRemoved(control, expectedInput) {
	assert.match(control.prompt, new RegExp(`USER:\\n${expectedInput}`));
	assert.ok(control.promptPath.endsWith("/prompt.txt"));
	assert.equal(readFileExists(control.promptPath), false, "prompt file should be removed");
	assert.equal(readFileExists(dirname(control.promptPath)), false, "prompt directory should be removed");
}

function readFileExists(path) {
	try {
		readFileSync(path);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

test("successful model turns remove the prompt file and temporary directory", async () => {
	const input = "success lifecycle input";
	await withFakeCli("success", async ({ controlPath }) => {
		const events = await collectWithWatchdog(collectEvents(streamGrokCli(fakeModel(), testContext(input))));
		const control = await waitForControl(controlPath);

		assert.deepEqual(events.map((event) => event.type), ["start", "text_start", "text_delta", "text_end", "done"]);
		assert.equal(events.at(-1).reason, "stop");
		assertPromptWasReadAndRemoved(control, input);
	});
});

test("non-zero CLI exits remove the prompt file and temporary directory", async () => {
	const input = "failure lifecycle input";
	await withFakeCli("failure", async ({ controlPath }) => {
		const events = await collectWithWatchdog(collectEvents(streamGrokCli(fakeModel(), testContext(input))));
		const control = await waitForControl(controlPath);

		assert.deepEqual(events.map((event) => event.type), ["start", "error"]);
		const error = events.at(-1);
		assert.equal(error.reason, "error");
		assert.match(error.error.errorMessage, /fake CLI failure/);
		assertPromptWasReadAndRemoved(control, input);
	});
});

test("timeouts remove the prompt file and temporary directory", async () => {
	const input = "timeout lifecycle input";
	await withFakeCli("timeout", async ({ controlPath }) => {
		const events = await collectWithWatchdog(collectEvents(streamGrokCli(fakeModel(), testContext(input))));
		const control = await waitForControl(controlPath);

		assert.deepEqual(events.map((event) => event.type), ["start", "error"]);
		const error = events.at(-1);
		assert.equal(error.reason, "error");
		assert.equal(error.error.errorMessage, "grok timed out after 250ms");
		assertPromptWasReadAndRemoved(control, input);
	});
});

test("in-flight aborts remove the prompt file and temporary directory", async () => {
	const input = "abort lifecycle input";
	await withFakeCli("abort", async ({ controlPath }) => {
		const controller = new AbortController();
		const eventsPromise = collectEvents(streamGrokCli(fakeModel(), testContext(input), { signal: controller.signal }));
		const control = await waitForControl(controlPath);
		controller.abort();
		const events = await collectWithWatchdog(eventsPromise);

		assert.deepEqual(events.map((event) => event.type), ["start", "error"]);
		const error = events.at(-1);
		assert.equal(error.reason, "aborted");
		assert.equal(error.error.errorMessage, "Request was aborted");
		assertPromptWasReadAndRemoved(control, input);
	});
});
