import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piFusionExtension from "../dist/index.js";
import { defaultConfig, defaultStats } from "../dist/config.js";
import { loadPreferences, PREFERENCE_FILE_NAMES, preferencesPath, savePreferencesPatch } from "../dist/preferences.js";

const execFileAsync = promisify(execFile);

const MODELS = [
	["openai-codex", "gpt-5.6-luna"],
	["groq", "sidekick"],
	["openai-codex", "upgrade"],
	["openai-codex", "frontier"],
	["flag", "sidekick"],
	["flag", "upgrade"],
	["flag", "frontier"],
];

function createRuntime({ flags = {}, branch = [] } = {}) {
	const handlers = new Map();
	const commands = new Map();
	const tools = new Map();
	const flagsSeen = new Map();
	const notices = [];
	const appended = [];
	let activeTools = [];
	const modelRegistry = {
		find(provider, modelId) {
			return MODELS.some(([knownProvider, knownId]) => knownProvider === provider && knownId === modelId)
				? { provider, id: modelId, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }
				: undefined;
		},
		getAvailable() {
			return MODELS.map(([provider, id]) => ({ provider, id }));
		},
	};
	const api = {
		registerFlag(name, definition) {
			flagsSeen.set(name, definition);
		},
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
			appended.push({ customType, data });
		},
		getActiveTools() {
			return activeTools;
		},
		setActiveTools(tools) {
			activeTools = tools;
		},
		async setModel() {
			return true;
		},
	};
	const context = {
		hasUI: true,
		cwd: "/tmp",
		model: { provider: "openai-codex", id: "gpt-5.6-luna" },
		modelRegistry,
		sessionManager: {
			getBranch() {
				return branch;
			},
		},
		ui: {
			theme: { fg: (_color, text) => text },
			notify(message, level) {
				notices.push({ message, level });
			},
			setWorkingMessage() {},
			setStatus() {},
			select: async () => undefined,
			input: async () => undefined,
			confirm: async () => false,
		},
	};

	piFusionExtension(api);
	return {
		context,
		flagsSeen,
		notices,
		appended,
		async start() {
			await handlers.get("session_start")?.({}, context);
		},
		async tree() {
			await handlers.get("session_tree")?.({}, context);
		},
		async delegate(task) {
			return tools.get("delegate")("call-id", { task }, undefined, undefined, context);
		},
		async command(args) {
			await commands.get("fusion")(args, context);
			return notices.at(-1)?.message ?? "";
		},
	};
}

function withAgentDir() {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const root = mkdtempSync(join(tmpdir(), "pi-fusion-preferences-"));
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

describe("durable pi-fusion preferences", { concurrency: false }, () => {
	it("only saves a deliberate edit, never startup flag or default values", async () => {
		const temp = withAgentDir();
		try {
			const runtime = createRuntime({ flags: { "fusion-enabled": false, "fusion-thinking": "low" } });
			await runtime.start();
			assert.deepEqual(preferenceFiles(temp.root), []);
			await runtime.command("max-delegations 4");
			assert.deepEqual(JSON.parse(readStored(temp.root)), { maxDelegations: 4 });
			const fresh = createRuntime();
			await fresh.start();
			assert.match(await fresh.command("status"), /pi-fusion enabled/);
			assert.match(await fresh.command("status"), /delegations: 0\/4/);
		} finally {
			temp.cleanup();
		}
	});

	it("survive a genuinely new runtime while excluding session state", async () => {
		const temp = withAgentDir();
		try {
			const first = createRuntime();
			await first.start();
			await first.command("disable");
			await first.command("sidekick groq/sidekick");
			await first.command("upgrade openai-codex/upgrade");
			await first.command("frontier openai-codex/frontier");
			await first.command("tools readonly");
			await first.command("thinking low");
			await first.command("max-delegations 7");
			await first.command("routing on");

			const stored = JSON.parse(readStored(temp.root));
			assert.deepEqual(stored, {
				enabled: false,
				sidekick: { provider: "groq", modelId: "sidekick" },
				sidekickUpgrade: { provider: "openai-codex", modelId: "upgrade" },
				frontier: { provider: "openai-codex", modelId: "frontier" },
				thinkingLevel: "low",
				toolMode: "readonly",
				maxDelegations: 7,
				routing: true,
			});
			assert.equal("stats" in stored, false);
			assert.equal("timeoutMs" in stored, false);
			assert.equal("maxTaskChars" in stored, false);

			const second = createRuntime();
			await second.start();
			const status = await second.command("status");
			assert.match(status, /pi-fusion disabled/);
			assert.match(status, /sidekick: groq\/sidekick \(available\)/);
			assert.match(status, /tools: readonly/);
			assert.match(status, /thinking: low/);
			assert.match(status, /delegations: 0\/7/);
			assert.match(status, /routing: on/);
		} finally {
			temp.cleanup();
		}
	});

	it("replays branch settings in memory without overwriting global preferences", async () => {
		const temp = withAgentDir();
		try {
			const writer = createRuntime();
			await writer.start();
			await writer.command("disable");
			await writer.command("sidekick groq/sidekick");
			await writer.command("max-delegations 7");
			const before = readStored(temp.root);
			const branchConfig = {
				...defaultConfig(),
				enabled: true,
				sidekick: { provider: "openai-codex", modelId: "upgrade" },
				thinkingLevel: "high",
				toolMode: "coding",
				maxDelegations: 99,
				routing: true,
			};
			const branch = [{
				type: "custom",
				customType: "pi-fusion-state",
				data: {
					version: 1,
					config: branchConfig,
					stats: { ...defaultStats(), delegations: 6, failures: 4, consecutiveFailures: 2 },
				},
			}];
			const replay = createRuntime({ branch });
			await replay.start();
			const status = await replay.command("status");
			assert.match(status, /pi-fusion enabled/);
			assert.match(status, /sidekick: openai-codex\/upgrade \(available\)/);
			assert.match(status, /thinking: high/);
			assert.match(status, /tools: coding/);
			assert.match(status, /delegations: 6\/99 \(4 failed\)/);
			assert.equal(readStored(temp.root), before);

			const fresh = createRuntime();
			await fresh.start();
			const freshStatus = await fresh.command("status");
			assert.match(freshStatus, /pi-fusion disabled/);
			assert.match(freshStatus, /sidekick: groq\/sidekick \(available\)/);
			assert.match(freshStatus, /delegations: 0\/7/);
		} finally {
			temp.cleanup();
		}
	});

	it("lets explicit startup flags override stored and branch values without writing them back", async () => {
		const temp = withAgentDir();
		try {
			assert.equal(await savePreferencesPatch({
				enabled: true,
				sidekick: { provider: "groq", modelId: "sidekick" },
				thinkingLevel: "max",
				toolMode: "coding",
				maxDelegations: 25,
				routing: true,
			}), true);
			const before = readStored(temp.root);
			const branch = [{
				type: "custom",
				customType: "pi-fusion-state",
				data: { version: 1, config: { ...defaultConfig(), enabled: true, sidekick: { provider: "openai-codex", modelId: "upgrade" }, maxDelegations: 99 } },
			}];
			const runtime = createRuntime({
				branch,
				flags: {
					"fusion-enabled": false,
					"fusion-sidekick": "flag/sidekick",
					"fusion-sidekick-upgrade": "flag/upgrade",
					"fusion-frontier": "flag/frontier",
					"fusion-tools": "readonly",
					"fusion-thinking": "low",
					"fusion-max-delegations": "3",
					"fusion-routing": false,
				},
			});
			await runtime.start();
			const status = await runtime.command("status");
			assert.match(status, /pi-fusion disabled/);
			assert.match(status, /sidekick: flag\/sidekick \(available\)/);
			assert.match(status, /tools: readonly/);
			assert.match(status, /thinking: low/);
			assert.match(status, /delegations: 0\/3/);
			assert.match(status, /routing: off/);
			assert.match(status, /upgrade: flag\/upgrade/);
			assert.match(status, /frontier: flag\/frontier/);
			assert.equal(readStored(temp.root), before);
			assert.equal(runtime.flagsSeen.get("fusion-enabled").default, undefined);
			assert.equal(runtime.flagsSeen.get("fusion-routing").default, undefined);
		} finally {
			temp.cleanup();
		}
	});

	it("keeps a command edit through tool execution but reapplies flags on tree navigation", async () => {
		const temp = withAgentDir();
		try {
			const branch = [{ type: "custom", customType: "pi-fusion-state", data: {
				version: 1,
				config: { ...defaultConfig(), enabled: true },
				stats: { ...defaultStats(), delegations: 2 },
			} }];
			const runtime = createRuntime({ branch, flags: {
				"fusion-enabled": false, "fusion-sidekick": "flag/sidekick", "fusion-max-delegations": "3",
			} });
			await runtime.start();
			assert.match(await runtime.command("status"), /pi-fusion disabled/);
			assert.deepEqual(preferenceFiles(temp.root), [], "startup flag is not durable");
			await runtime.command("enable");
			await runtime.command("sidekick groq/sidekick");
			await runtime.command("max-delegations 1");
			const result = await runtime.delegate("check command override");
			assert.match(result.content[0].text, /Delegation budget exhausted/);
			assert.equal(result.details.state.config.enabled, true);
			assert.equal(result.details.fusion.sidekick, "groq/sidekick");
			assert.equal(result.details.state.stats.delegations, 2);
			assert.equal(result.details.fusion.maxDelegations, 1);
			assert.match((await runtime.delegate("again")).content[0].text, /Delegation budget exhausted/);
			assert.match(await runtime.command("status"), /pi-fusion enabled/);
			assert.deepEqual(JSON.parse(readStored(temp.root)), { enabled: true, sidekick: { provider: "groq", modelId: "sidekick" }, maxDelegations: 1 });
			branch.push({ type: "message", message: { role: "toolResult", toolName: "delegate", details: result.details } });
			await runtime.tree();
			assert.match(await runtime.command("status"), /pi-fusion disabled/);
			assert.match(await runtime.command("status"), /sidekick: flag\/sidekick/);
			assert.match((await runtime.delegate("after tree")).content[0].text, /pi-fusion is disabled/);
			assert.match(await runtime.command("status"), /delegations: 2\/3/);
			assert.deepEqual(JSON.parse(readStored(temp.root)), { enabled: true, sidekick: { provider: "groq", modelId: "sidekick" }, maxDelegations: 1 }, "tree replay does not persist flags");
		} finally {
			temp.cleanup();
		}
	});

	it("keeps an explicit disable despite an enabled startup flag", async () => {
		const temp = withAgentDir();
		try {
			const runtime = createRuntime({ flags: { "fusion-enabled": true } });
			await runtime.start();
			await runtime.command("disable");
			assert.match((await runtime.delegate("disabled in this session")).content[0].text, /pi-fusion is disabled/);
			assert.deepEqual(JSON.parse(readStored(temp.root)), { enabled: false });
			await runtime.tree();
			assert.match(await runtime.command("status"), /pi-fusion enabled/);
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
			["thinkingLevel", { thinkingLevel: "low" }],
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
			await waitForFiles(jobs.map((_job, index) => join(temp.root, `ready-${["enabled", "thinkingLevel"][index]}`)));
			await Promise.all(jobs);
			assert.deepEqual(loadPreferences(temp.root), { enabled: true, thinkingLevel: "low" });
			assert.equal(existsSync(join(temp.root, "pi-fusion.json")), false);
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

	it("loads valid fields independently and rejects bad input without writing", async () => {
		const temp = withAgentDir();
		try {
			assert.equal(await savePreferencesPatch({ enabled: true }, temp.root), true);
			writeFileSync(join(preferencesPath(temp.root), PREFERENCE_FILE_NAMES.enabled), JSON.stringify({ version: 1, enabled: "false" }));
			writeFileSync(join(preferencesPath(temp.root), PREFERENCE_FILE_NAMES.sidekick), JSON.stringify({ version: 1, sidekick: { provider: "valid", modelId: "model" } }));
			writeFileSync(join(preferencesPath(temp.root), PREFERENCE_FILE_NAMES.sidekickUpgrade), JSON.stringify({ version: 1, sidekickUpgrade: "bad" }));
			writeFileSync(join(preferencesPath(temp.root), PREFERENCE_FILE_NAMES.frontier), JSON.stringify({ version: 1, frontier: { provider: "", modelId: "bad" } }));
			writeFileSync(join(preferencesPath(temp.root), PREFERENCE_FILE_NAMES.thinkingLevel), JSON.stringify({ version: 1, thinkingLevel: "bogus" }));
			writeFileSync(join(preferencesPath(temp.root), PREFERENCE_FILE_NAMES.toolMode), JSON.stringify({ version: 1, toolMode: "bad" }));
			writeFileSync(join(preferencesPath(temp.root), PREFERENCE_FILE_NAMES.maxDelegations), JSON.stringify({ version: 1, maxDelegations: "7" }));
			writeFileSync(join(preferencesPath(temp.root), PREFERENCE_FILE_NAMES.routing), JSON.stringify({ version: 1, routing: "true" }));
			assert.deepEqual(loadPreferences(temp.root), { sidekick: { provider: "valid", modelId: "model" } });

			writeFileSync(join(preferencesPath(temp.root), PREFERENCE_FILE_NAMES.enabled), JSON.stringify({ version: 9, enabled: false }));
			assert.deepEqual(loadPreferences(temp.root), { sidekick: { provider: "valid", modelId: "model" } });

			const before = readdirSync(preferencesPath(temp.root)).sort();
			assert.equal(await savePreferencesPatch({ enabled: true, bogus: true }, temp.root), false);
			assert.deepEqual(readdirSync(preferencesPath(temp.root)).sort(), before);

			const blocked = join(temp.root, "not-a-directory");
			writeFileSync(blocked, "occupied");
			assert.equal(await savePreferencesPatch({ enabled: false }, blocked), false);
			assert.deepEqual(readdirSync(preferencesPath(temp.root)).filter((name) => name.endsWith(".tmp")), []);

			assert.equal(await savePreferencesPatch({ enabled: true }, temp.root), true);
			assert.equal(statSync(join(preferencesPath(temp.root), PREFERENCE_FILE_NAMES.enabled)).mode & 0o077, 0);
			if (process.getuid?.() !== 0) {
				chmodSync(preferencesPath(temp.root), 0o500);
				try {
					assert.equal(await savePreferencesPatch({ enabled: false }, temp.root), false);
					assert.equal(loadPreferences(temp.root).enabled, true);
				} finally {
					chmodSync(preferencesPath(temp.root), 0o700);
				}
			}
			assert.equal(loadPreferences(temp.root).enabled, true);
		} finally {
			temp.cleanup();
		}
	});
});
