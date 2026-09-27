import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import advisorPiExtension, {
	DEFAULT_ADVISOR_MODEL,
	LEGACY_DEFAULT_ADVISOR_MODEL,
	defaultConfig,
} from "../dist/index.js";
import {
	loadPreferences,
	PREFERENCE_FILE_NAMES,
	preferencesPath,
	savePreferences,
	savePreferencesPatch,
} from "../dist/preferences.js";

const execFileAsync = promisify(execFile);

function createRuntime({ flags = {}, branch = [], models } = {}) {
	const knownModels = models ? new Set(models) : undefined;
	const handlers = new Map();
	const commands = new Map();
	const tools = new Map();
	const notices = [];
	const entries = [];
	let activeTools = [];
	const api = {
		registerFlag() {},
		getFlag(name) {
			return Object.prototype.hasOwnProperty.call(flags, name) ? flags[name] : undefined;
		},
		registerTool(definition) {
			tools.set(definition.name, definition.execute);
		},
		registerCommand(name, definition) {
			commands.set(name, definition.handler);
		},
		on(name, handler) {
			handlers.set(name, handler);
		},
		appendEntry(customType, data) {
			entries.push({ customType, data });
		},
		getActiveTools() {
			return activeTools;
		},
		setActiveTools(tools) {
			activeTools = tools;
		},
	};
	advisorPiExtension(api);
	const context = {
		hasUI: false,
		modelRegistry: {
			find: (provider, modelId) => {
				if (knownModels && !knownModels.has(`${provider}/${modelId}`)) return undefined;
				return { provider, id: modelId };
			},
			getAvailable: () => [],
		},
		sessionManager: {
			getBranch: () => branch,
		},
		ui: {
			notify(message, level) {
				notices.push({ message, level });
			},
			setStatus() {},
			theme: { fg: (_color, text) => text },
		},
	};
	return {
		context,
		notices,
		entries,
		async start() {
			await handlers.get("session_start")?.({}, context);
		},
		async tree() {
			await handlers.get("session_tree")?.({}, context);
		},
		async consult(question) {
			return tools.get("advisor")("call-id", { question }, undefined, undefined, context);
		},
		async command(args) {
			await commands.get("advisor-pi")(args, context);
			return notices.at(-1)?.message;
		},
	};
}

function withAgentDir() {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const root = mkdtempSync(join(tmpdir(), "advisor-pi-preferences-"));
	process.env.PI_CODING_AGENT_DIR = root;
	return {
		root,
		cleanup() {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function readStored(root) {
	return JSON.stringify(loadPreferences(root));
}

function preferenceFiles(root) {
	const directory = preferencesPath(root);
	return existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(".json")) : [];
}

async function waitForFiles(paths) {
	const deadline = Date.now() + 2_000;
	while (!paths.every(existsSync) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.ok(paths.every(existsSync), `timed out waiting for ${paths.join(", ")}`);
}

describe("durable advisor-pi preferences", { concurrency: false }, () => {
	it("saves only the edited field and does not persist startup flags", async () => {
		const temp = withAgentDir();
		try {
			const first = createRuntime({ flags: { "advisor-enabled": false, "advisor-thinking": "low" } });
			await first.start();
			assert.deepEqual(preferenceFiles(temp.root), []);
			await first.command("max-uses 9");
			assert.deepEqual(JSON.parse(readStored(temp.root)), { maxUses: 9 });
			const second = createRuntime();
			await second.start();
			assert.match(await second.command("status"), /advisor-pi enabled/);
			assert.match(await second.command("status"), /uses: 0\/9/);
		} finally {
			temp.cleanup();
		}
	});

	it("preserves an explicitly saved legacy model in a fresh runtime", async () => {
		const temp = withAgentDir();
		const models = [DEFAULT_ADVISOR_MODEL, LEGACY_DEFAULT_ADVISOR_MODEL];
		try {
			const first = createRuntime({ models });
			await first.start();
			await first.command(`model ${LEGACY_DEFAULT_ADVISOR_MODEL}`);
			assert.deepEqual(JSON.parse(readStored(temp.root)), { provider: "openai-codex", modelId: "gpt-5.5" });

			const second = createRuntime({ models });
			await second.start();
			assert.match(await second.command("status"), /model: openai-codex\/gpt-5\.5 \(available\)/);
		} finally {
			temp.cleanup();
		}
	});

	it("explicit flags win over existing branch replay", async () => {
		const temp = withAgentDir();
		try {
			const branch = [{ type: "custom", customType: "advisor-pi-state", data: {
				version: 1, config: { ...defaultConfig(), enabled: true, maxUses: 99 }, useCount: 4,
			} }];
			const runtime = createRuntime({ branch, flags: { "advisor-enabled": false, "advisor-max-uses": "6" } });
			await runtime.start();
			const status = await runtime.command("status");
			assert.match(status, /advisor-pi disabled/);
			assert.match(status, /uses: 4\/6/);
		} finally {
			temp.cleanup();
		}
	});

	it("survive a fresh empty session without persisting useCount or runtime-only fields", async () => {
		const temp = withAgentDir();
		try {
			const first = createRuntime();
			await first.start();
			await first.command("disable");
			await first.command("model groq/advisor");
			await first.command("thinking medium");
			await first.command("max-uses 8");
			await first.command("cache long");
			await first.command("max-transcript-chars 9000");

			const stored = JSON.parse(readStored(temp.root));
			assert.equal(stored.enabled, false);
			assert.deepEqual({ provider: stored.provider, modelId: stored.modelId }, { provider: "groq", modelId: "advisor" });
			assert.equal(stored.thinkingLevel, "medium");
			assert.equal(stored.maxUses, 8);
			assert.equal(stored.cacheRetention, "long");
			assert.equal(stored.maxTranscriptChars, 9000);
			assert.equal("useCount" in stored, false);
			assert.equal("maxTokens" in stored, false);
			assert.equal("timeoutMs" in stored, false);
			assert.equal(statSync(join(preferencesPath(temp.root), PREFERENCE_FILE_NAMES.enabled)).mode & 0o077, 0);
			assert.deepEqual(readdirSync(preferencesPath(temp.root)).filter((name) => name.endsWith(".tmp")), []);

			const second = createRuntime();
			await second.start();
			const status = await second.command("status");
			assert.match(status, /advisor-pi disabled/);
			assert.match(status, /model: groq\/advisor \(available\)/);
			assert.match(status, /thinking: medium/);
			assert.match(status, /uses: 0\/8/);
			assert.match(status, /transcript: max 9000 chars/);
			assert.match(status, /cache: long/);
		} finally {
			temp.cleanup();
		}
	});

	it("replays branch state without writing branch values into durable preferences", async () => {
		const temp = withAgentDir();
		try {
			const writer = createRuntime();
			await writer.start();
			await writer.command("disable");
			await writer.command("max-uses 8");
			const before = readStored(temp.root);
			const branchConfig = {
				...defaultConfig(),
				enabled: true,
				provider: "branch",
				modelId: "advisor",
				thinkingLevel: "low",
				maxUses: 99,
				cacheRetention: "none",
				maxTranscriptChars: 321,
			};
			const branch = [{
				type: "custom",
				customType: "advisor-pi-state",
				data: { version: 1, config: branchConfig, useCount: 6 },
			}];
			const replay = createRuntime({ branch });
			await replay.start();
			const replayStatus = await replay.command("status");
			assert.match(replayStatus, /advisor-pi enabled/);
			assert.match(replayStatus, /model: branch\/advisor \(available\)/);
			assert.match(replayStatus, /uses: 6\/99/);
			assert.equal(readStored(temp.root), before);

			const fresh = createRuntime();
			await fresh.start();
			const freshStatus = await fresh.command("status");
			assert.match(freshStatus, /advisor-pi disabled/);
			assert.match(freshStatus, /uses: 0\/8/);
		} finally {
			temp.cleanup();
		}
	});

	it("lets explicit startup flags override stored values without writing them back", async () => {
		const temp = withAgentDir();
		try {
			assert.equal(await savePreferences({ enabled: false, provider: defaultConfig().provider, modelId: defaultConfig().modelId, maxUses: 8 }, temp.root), true);
			const before = readStored(temp.root);
			const runtime = createRuntime({
				flags: {
					"advisor-enabled": true,
					"advisor-model": "flag/advisor",
					"advisor-thinking": "low",
					"advisor-max-uses": "3",
					"advisor-cache": "none",
					"advisor-max-transcript-chars": "500",
				},
			});
			await runtime.start();
			const status = await runtime.command("status");
			assert.match(status, /advisor-pi enabled/);
			assert.match(status, /model: flag\/advisor \(available\)/);
			assert.match(status, /thinking: low/);
			assert.match(status, /uses: 0\/3/);
			assert.match(status, /transcript: max 500 chars/);
			assert.match(status, /cache: none/);
			assert.equal(readStored(temp.root), before);
		} finally {
			temp.cleanup();
		}
	});

	it("keeps command overrides through tool calls but reapplies flags on tree navigation", async () => {
		const temp = withAgentDir();
		try {
			const branch = [{ type: "custom", customType: "advisor-pi-state", data: {
				version: 1, config: { ...defaultConfig(), enabled: true }, useCount: 2,
			} }];
			const runtime = createRuntime({ branch, flags: {
				"advisor-enabled": false, "advisor-model": "flag/advisor", "advisor-max-uses": "3",
			} });
			await runtime.start();
			assert.match(await runtime.command("status"), /advisor-pi disabled/);
			assert.deepEqual(preferenceFiles(temp.root), [], "startup flags are not durable");
			await runtime.command("enable");
			await runtime.command("model groq/advisor");
			await runtime.command("max-uses 1");
			const result = await runtime.consult("check command override");
			assert.match(result.content[0].text, /Advisor use limit reached/);
			assert.equal(result.details.state.config.enabled, true);
			assert.equal(result.details.state.config.provider, "groq");
			assert.equal(result.details.state.useCount, 2);
			assert.equal(result.details.advisor.maxUses, 1);
			assert.match((await runtime.consult("again")).content[0].text, /Advisor use limit reached/);
			assert.match(await runtime.command("status"), /advisor-pi enabled/);
			assert.deepEqual(JSON.parse(readStored(temp.root)), { enabled: true, provider: "groq", modelId: "advisor", maxUses: 1 });
			branch.push({ type: "message", message: { role: "toolResult", toolName: "advisor", details: result.details } });
			await runtime.tree();
			assert.match(await runtime.command("status"), /advisor-pi disabled/);
			assert.match(await runtime.command("status"), /model: flag\/advisor/);
			assert.match((await runtime.consult("after tree")).content[0].text, /advisor-pi is disabled/);
			assert.match(await runtime.command("status"), /uses: 2\/3/);
			assert.deepEqual(JSON.parse(readStored(temp.root)), { enabled: true, provider: "groq", modelId: "advisor", maxUses: 1 });
		} finally {
			temp.cleanup();
		}
	});

	it("keeps an explicit disable despite an enabled startup flag", async () => {
		const temp = withAgentDir();
		try {
			const runtime = createRuntime({ flags: { "advisor-enabled": true } });
			await runtime.start();
			await runtime.command("disable");
			assert.match((await runtime.consult("disabled in this session")).content[0].text, /advisor-pi is disabled/);
			assert.deepEqual(JSON.parse(readStored(temp.root)), { enabled: false });
			await runtime.tree();
			assert.match(await runtime.command("status"), /advisor-pi enabled/);
		} finally {
			temp.cleanup();
		}
	});

	it("atomically lets concurrent same-key writers finish with one complete value", async () => {
		const temp = withAgentDir();
		try {
			const moduleUrl = new URL("../dist/preferences.js", import.meta.url).href;
			const write = (enabled) => execFileAsync(process.execPath, [
				"--input-type=module", "-e",
				`import { savePreferencesPatch } from ${JSON.stringify(moduleUrl)}; for (let i = 0; i < 12; i++) if (!(await savePreferencesPatch({ enabled: ${enabled} }, process.env.PI_CODING_AGENT_DIR))) process.exit(1);`,
			], { env: { ...process.env, PI_CODING_AGENT_DIR: temp.root } });
			await Promise.all([write(true), write(false)]);
			assert.ok(typeof loadPreferences(temp.root).enabled === "boolean");
			assert.equal(JSON.parse(readFileSync(join(preferencesPath(temp.root), PREFERENCE_FILE_NAMES.enabled), "utf8")).enabled, loadPreferences(temp.root).enabled);
			assert.equal(await savePreferencesPatch({ enabled: false }, temp.root), true);
			assert.equal(await savePreferencesPatch({ enabled: true }, temp.root), true);
			assert.equal(loadPreferences(temp.root).enabled, true); // last successful rename wins
			assert.deepEqual(readdirSync(preferencesPath(temp.root)).filter((name) => name.endsWith(".tmp")), []);
		} finally {
			temp.cleanup();
		}
	});

	it("merges different-key edits from concurrent processes without a lock", async () => {
		const temp = withAgentDir();
		const moduleUrl = new URL("../dist/preferences.js", import.meta.url).href;
		const jobs = [
			["enabled", { enabled: true }],
			["maxUses", { maxUses: 9 }],
		].map(([key, patch]) => {
			const readyPath = join(temp.root, `ready-${key}`);
			const script = `
import { writeFileSync } from "node:fs";
import { savePreferencesPatch } from ${JSON.stringify(moduleUrl)};
writeFileSync(${JSON.stringify(readyPath)}, "ready");
if (!(await savePreferencesPatch(${JSON.stringify(patch)}, process.env.PI_CODING_AGENT_DIR))) process.exit(1);
`;
			return execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
				env: { ...process.env, PI_CODING_AGENT_DIR: temp.root },
				timeout: 5_000,
			});
		});
		try {
			await waitForFiles(jobs.map((_job, index) => join(temp.root, `ready-${["enabled", "maxUses"][index]}`)));
			await Promise.all(jobs);
			assert.deepEqual(loadPreferences(temp.root), { enabled: true, maxUses: 9 });
			assert.equal(existsSync(join(temp.root, "advisor-pi.json")), false);
			assert.equal(readdirSync(preferencesPath(temp.root)).some((name) => name.endsWith(".lock")), false);
			assert.deepEqual(readdirSync(preferencesPath(temp.root)).filter((name) => name.endsWith(".tmp")), []);
		} finally {
			await Promise.allSettled(jobs);
			temp.cleanup();
		}
	});

	it("ignores an orphan temp left by a killed writer", async () => {
		const temp = withAgentDir();
		try {
			assert.equal(await savePreferencesPatch({ enabled: false }, temp.root), true);
			const readyPath = join(temp.root, "writer-ready");
			const moduleUrl = new URL("../dist/preferences.js", import.meta.url).href;
			const child = spawn(process.execPath, [
				"--input-type=module", "-e",
				`import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
fs.renameSync = () => { fs.writeFileSync(${JSON.stringify(readyPath)}, "ready"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
syncBuiltinESMExports();
const { savePreferencesPatch } = await import(${JSON.stringify(moduleUrl)});
await savePreferencesPatch({ enabled: true }, ${JSON.stringify(temp.root)});`,
			]);
			await waitForFiles([readyPath]);
			const orphanName = readdirSync(preferencesPath(temp.root)).find((name) => name.startsWith(`.${PREFERENCE_FILE_NAMES.enabled}.`) && name.endsWith(".tmp"));
			assert.ok(orphanName);
			const orphanPath = join(preferencesPath(temp.root), orphanName);
			child.kill("SIGKILL");
			await new Promise((resolve) => child.once("exit", resolve));
			assert.equal(loadPreferences(temp.root).enabled, false);
			assert.equal(await savePreferencesPatch({ enabled: true }, temp.root), true);
			assert.equal(loadPreferences(temp.root).enabled, true);
			assert.equal(existsSync(orphanPath), true);
		} finally {
			temp.cleanup();
		}
	});

	it("ignores malformed stored values and rejects bad input without writing", async () => {
		const temp = withAgentDir();
		try {
			assert.equal(await savePreferencesPatch({ enabled: false }, temp.root), true);
			writeFileSync(join(preferencesPath(temp.root), PREFERENCE_FILE_NAMES.enabled), JSON.stringify({ version: 1, enabled: "false" }));
			writeFileSync(join(preferencesPath(temp.root), PREFERENCE_FILE_NAMES.model), JSON.stringify({ version: 1, provider: "valid", modelId: "advisor" }));
			writeFileSync(join(preferencesPath(temp.root), PREFERENCE_FILE_NAMES.thinkingLevel), JSON.stringify({ version: 1, thinkingLevel: "bogus" }));
			writeFileSync(join(preferencesPath(temp.root), PREFERENCE_FILE_NAMES.maxUses), JSON.stringify({ version: 1, maxUses: "8" }));
			writeFileSync(join(preferencesPath(temp.root), PREFERENCE_FILE_NAMES.cacheRetention), JSON.stringify({ version: 1, cacheRetention: "forever" }));
			writeFileSync(join(preferencesPath(temp.root), PREFERENCE_FILE_NAMES.maxTranscriptChars), JSON.stringify({ version: 1, maxTranscriptChars: Number.POSITIVE_INFINITY }));
			assert.deepEqual(loadPreferences(temp.root), { provider: "valid", modelId: "advisor" });

			const before = readdirSync(preferencesPath(temp.root)).sort();
			assert.equal(await savePreferencesPatch({ enabled: true, unknown: true }, temp.root), false);
			assert.deepEqual(readdirSync(preferencesPath(temp.root)).sort(), before);

			const blocked = join(temp.root, "not-a-directory");
			writeFileSync(blocked, "occupied");
			assert.equal(await savePreferences({ enabled: false, provider: "valid", modelId: "advisor" }, blocked), false);
			assert.deepEqual(readdirSync(preferencesPath(temp.root)).filter((name) => name.endsWith(".tmp")), []);
			assert.equal(await savePreferencesPatch({ provider: "valid" }, temp.root), false);
			assert.deepEqual(loadPreferences(temp.root), { provider: "valid", modelId: "advisor" });
			assert.equal(await savePreferencesPatch({ provider: "groq", modelId: "second" }, temp.root), true);
			assert.deepEqual(loadPreferences(temp.root), { provider: "groq", modelId: "second" });
			if (process.getuid?.() !== 0) {
				chmodSync(preferencesPath(temp.root), 0o500);
				try {
					assert.equal(await savePreferencesPatch({ provider: "broken", modelId: "model" }, temp.root), false);
					assert.deepEqual(loadPreferences(temp.root), { provider: "groq", modelId: "second" });
				} finally {
					chmodSync(preferencesPath(temp.root), 0o700);
				}
			}
		} finally {
			temp.cleanup();
		}
	});
});
