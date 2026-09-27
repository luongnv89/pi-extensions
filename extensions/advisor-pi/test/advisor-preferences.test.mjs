import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import advisorPiExtension, { defaultConfig } from "../dist/index.js";
import {
	loadPreferences,
	preferencesLockPath,
	preferencesPath,
	savePreferences,
	savePreferencesPatch,
} from "../dist/preferences.js";

const execFileAsync = promisify(execFile);

function createRuntime({ flags = {}, branch = [] } = {}) {
	const handlers = new Map();
	const commands = new Map();
	const notices = [];
	const entries = [];
	let activeTools = [];
	const api = {
		registerFlag() {},
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
			find: (provider, modelId) => ({ provider, id: modelId }),
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
	return readFileSync(join(root, "advisor-pi.json"), "utf8");
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
			assert.equal(existsSync(preferencesPath()), false);
			await first.command("max-uses 9");
			assert.deepEqual(JSON.parse(readStored(temp.root)), { version: 1, maxUses: 9 });
			const second = createRuntime();
			await second.start();
			assert.match(await second.command("status"), /advisor-pi enabled/);
			assert.match(await second.command("status"), /uses: 0\/9/);
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
			assert.equal(stored.version, 1);
			assert.equal(stored.enabled, false);
			assert.deepEqual({ provider: stored.provider, modelId: stored.modelId }, { provider: "groq", modelId: "advisor" });
			assert.equal(stored.thinkingLevel, "medium");
			assert.equal(stored.maxUses, 8);
			assert.equal(stored.cacheRetention, "long");
			assert.equal(stored.maxTranscriptChars, 9000);
			assert.equal("useCount" in stored, false);
			assert.equal("maxTokens" in stored, false);
			assert.equal("timeoutMs" in stored, false);
			assert.equal(statSync(preferencesPath()).mode & 0o077, 0);
			assert.deepEqual(readdirSync(temp.root).filter((name) => name.endsWith(".tmp")), []);

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
			assert.equal(await savePreferences({ ...defaultConfig(), enabled: false, maxUses: 8 }, temp.root), true);
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

	it("merges different-key edits from two processes after a shared lock gate", async () => {
		const temp = withAgentDir();
		const lockPath = preferencesLockPath(temp.root);
		mkdirSync(lockPath, { mode: 0o700 });
		let parentOwnsLock = true;
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
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(existsSync(preferencesPath(temp.root)), false);
			assert.equal(existsSync(lockPath), true);
			rmdirSync(lockPath);
			parentOwnsLock = false;
			await Promise.all(jobs);
			assert.deepEqual(JSON.parse(readStored(temp.root)), {
				version: 1,
				enabled: true,
				maxUses: 9,
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

	it("ignores malformed stored values and does not throw on write failure", async () => {
		const temp = withAgentDir();
		try {
			writeFileSync(
				preferencesPath(),
				JSON.stringify({
					version: 1,
					enabled: "false",
					provider: "valid",
					modelId: "advisor",
					thinkingLevel: "bogus",
					maxUses: "8",
					cacheRetention: "forever",
					maxTranscriptChars: Number.POSITIVE_INFINITY,
				}),
			);
			assert.deepEqual(loadPreferences(), { provider: "valid", modelId: "advisor" });
			const blocked = join(temp.root, "not-a-directory");
			writeFileSync(blocked, "occupied");
			assert.equal(await savePreferences(defaultConfig(), blocked), false);
		} finally {
			temp.cleanup();
		}
	});
});
