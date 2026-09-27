import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piFusionExtension from "../dist/index.js";
import { defaultConfig, defaultStats } from "../dist/config.js";
import { loadPreferences, preferencesLockPath, preferencesPath, savePreferencesPatch } from "../dist/preferences.js";

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
		registerTool() {},
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
	return readFileSync(join(root, "pi-fusion.json"), "utf8");
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
			assert.equal(existsSync(preferencesPath()), false);
			await runtime.command("max-delegations 4");
			assert.deepEqual(JSON.parse(readStored(temp.root)), { version: 1, maxDelegations: 4 });
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
				version: 1,
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

	it("two independent processes can replace the file without torn JSON", async () => {
		const temp = withAgentDir();
		try {
			const moduleUrl = new URL("../dist/preferences.js", import.meta.url).href;
			const write = (enabled, thinkingLevel) => execFileAsync(process.execPath, [
				"--input-type=module", "-e",
				`import { savePreferences } from ${JSON.stringify(moduleUrl)}; for (let i = 0; i < 12; i++) if (!(await savePreferences({ enabled: ${enabled}, thinkingLevel: ${JSON.stringify(thinkingLevel)} }, process.env.PI_CODING_AGENT_DIR))) process.exit(1);`,
			], { env: { ...process.env, PI_CODING_AGENT_DIR: temp.root } });
			await Promise.all([write(true, "low"), write(false, "high")]);
			const stored = JSON.parse(readStored(temp.root));
			assert.ok((stored.enabled === true && stored.thinkingLevel === "low") ||
				(stored.enabled === false && stored.thinkingLevel === "high"));
			assert.deepEqual(readdirSync(temp.root).filter((name) => name.endsWith(".tmp")), []);
		} finally {
			temp.cleanup();
		}
	});

	it("merges different-key edits from two processes after a shared lock gate", async () => {
		const temp = withAgentDir();
		const lockPath = preferencesLockPath(temp.root);
		mkdirSync(lockPath, { mode: 0o700 });
		let parentOwnsLock = true;
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
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(existsSync(preferencesPath(temp.root)), false);
			assert.equal(existsSync(lockPath), true);
			rmdirSync(lockPath);
			parentOwnsLock = false;
			await Promise.all(jobs);
			assert.deepEqual(JSON.parse(readStored(temp.root)), {
				version: 1,
				enabled: true,
				thinkingLevel: "low",
			});
			assert.deepEqual(readdirSync(temp.root).filter((name) => name.endsWith(".tmp")), []);
			assert.equal(existsSync(lockPath), false);
		} finally {
			if (parentOwnsLock) {
				if (existsSync(lockPath)) rmdirSync(lockPath);
				parentOwnsLock = false;
			}
			await Promise.allSettled(jobs);
			temp.cleanup();
		}
	});

	it("times out on a held lock, preserves it, and releases after write failure", async () => {
		const temp = withAgentDir();
		const lockPath = preferencesLockPath(temp.root);
		mkdirSync(lockPath, { mode: 0o700 });
		try {
			const moduleUrl = new URL("../dist/preferences.js", import.meta.url).href;
			const result = await execFileAsync(process.execPath, [
				"--input-type=module", "-e",
				`import { savePreferencesPatch } from ${JSON.stringify(moduleUrl)}; process.stdout.write(String(await savePreferencesPatch({ enabled: false }, process.env.PI_CODING_AGENT_DIR)));`,
			], {
				env: { ...process.env, PI_CODING_AGENT_DIR: temp.root },
				timeout: 4_000,
			});
			assert.equal(result.stdout.trim(), "false");
			assert.equal(existsSync(lockPath), true);
			assert.deepEqual(readdirSync(temp.root).filter((name) => name.endsWith(".tmp")), []);

			rmSync(lockPath, { recursive: true, force: true });
			mkdirSync(preferencesPath(temp.root));
			assert.equal(await savePreferencesPatch({ enabled: false }, temp.root), false);
			assert.equal(existsSync(lockPath), false);
			assert.deepEqual(readdirSync(temp.root).filter((name) => name.endsWith(".tmp")), []);

			rmSync(preferencesPath(temp.root), { recursive: true, force: true });
			assert.equal(await savePreferencesPatch({ enabled: false }, temp.root), true);
			assert.equal(existsSync(lockPath), false);
		} finally {
			rmSync(lockPath, { recursive: true, force: true });
			temp.cleanup();
		}
	});

	it("loads valid fields independently and fails closed on write errors", async () => {
		const temp = withAgentDir();
		try {
			writeFileSync(preferencesPath(), JSON.stringify({
				version: 1,
				enabled: "false",
				sidekick: { provider: "valid", modelId: "model" },
				sidekickUpgrade: "bad",
				frontier: { provider: "", modelId: "bad" },
				thinkingLevel: "bogus",
				toolMode: "bad",
				maxDelegations: "7",
				routing: "true",
			}));
			assert.deepEqual(loadPreferences(), { sidekick: { provider: "valid", modelId: "model" } });
			const stalePath = preferencesPath();
			writeFileSync(stalePath, JSON.stringify({ version: 9, enabled: false }));
			assert.deepEqual(loadPreferences(), {});

			const blocked = join(temp.root, "not-a-directory");
			writeFileSync(blocked, "occupied");
			assert.equal(await savePreferencesPatch({ enabled: false }, blocked), false);
			assert.deepEqual(readdirSync(temp.root).filter((name) => name.endsWith(".tmp")), []);

			assert.equal(await savePreferencesPatch({ enabled: true }), true);
			assert.equal(statSync(preferencesPath()).mode & 0o077, 0);
		} finally {
			temp.cleanup();
		}
	});
});
