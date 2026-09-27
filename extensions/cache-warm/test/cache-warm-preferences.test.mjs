import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cacheWarmExtension, {
	DEFAULT_ACTIVE_MS,
	loadPreferences,
	PREFERENCE_FILE_NAMES,
	preferencesPath,
	savePreferences,
	savePreferencesPatch,
} from "../dist/index.js";

const execFileAsync = promisify(execFile);

function createRuntime({ flags = {} } = {}) {
	const handlers = new Map();
	const commands = new Map();
	const notices = [];
	const registeredFlags = new Map();
	const api = {
		registerFlag(name, options) {
			registeredFlags.set(name, options);
		},
		getFlag(name) {
			return Object.prototype.hasOwnProperty.call(flags, name) ? flags[name] : undefined;
		},
		on(name, handler) {
			handlers.set(name, handler);
		},
		registerCommand(name, definition) {
			commands.set(name, definition.handler);
		},
		sendMessage() {},
	};
	cacheWarmExtension(api);
	const context = {
		hasUI: true,
		model: { provider: "openai", id: "model" },
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort() {},
		ui: {
			notify(message, level) {
				notices.push({ message, level });
			},
			setStatus() {},
		},
	};
	return {
		notices,
		registeredFlags,
		async start() {
			await handlers.get("session_start")?.({}, context);
		},
		async command(args) {
			await commands.get("cache-warm")(args, context);
			return notices.at(-1)?.message;
		},
		async shutdown() {
			await handlers.get("session_shutdown")?.({}, context);
		},
	};
}

function withAgentDir() {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const root = mkdtempSync(join(tmpdir(), "cache-warm-preferences-"));
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

describe("durable cache-warm preferences", { concurrency: false }, () => {
	it("does not create a file on startup or freeze unrelated defaults and flags", async () => {
		const temp = withAgentDir();
		try {
			const first = createRuntime({ flags: { "cache-warm-duration": "2h" } });
			await first.start();
			assert.deepEqual(preferenceFiles(temp.root), []);
			await first.command("rate off");
			assert.deepEqual(JSON.parse(readStored(temp.root)), { rateLimitEnabled: false });
			await first.shutdown();
			const second = createRuntime();
			await second.start();
			assert.match(await second.command("status"), /cache-warm: off/);
			assert.match(await second.command("status"), /idle limit: 30m/);
			await second.shutdown();
		} finally {
			temp.cleanup();
		}
	});

	it("persists duration and rate but never persists enablement across empty sessions", async () => {
		const temp = withAgentDir();
		try {
			const first = createRuntime();
			await first.start();
			await first.command("on");
			await first.command("duration 45m");
			await first.command("rate off");
			await first.command("off");
			const stored = JSON.parse(readStored(temp.root));
			assert.equal(stored.activeMs, 45 * 60_000);
			assert.equal(stored.rateLimitEnabled, false);
			assert.equal("enabled" in stored, false);
			assert.equal(statSync(join(preferencesPath(temp.root), PREFERENCE_FILE_NAMES.activeMs)).mode & 0o077, 0);
			assert.deepEqual(readdirSync(preferencesPath(temp.root)).filter((name) => name.endsWith(".tmp")), []);

			const second = createRuntime();
			await second.start();
			const status = await second.command("status");
			assert.match(status, /cache-warm: off/);
			assert.match(status, /idle limit: 45m/);
			assert.match(status, /rate limit: off/);
			await second.shutdown();
		} finally {
			temp.cleanup();
		}
	});

	it("uses explicit startup flags for this session without changing stored settings", async () => {
		const temp = withAgentDir();
		try {
			assert.equal(await savePreferences({ version: 1, activeMs: DEFAULT_ACTIVE_MS, rateLimitEnabled: false }, temp.root), true);
			const before = readStored(temp.root);
			const runtime = createRuntime({
				flags: {
					"cache-warm-enabled": true,
					"cache-warm-duration": "2h",
					"cache-warm-rate": "on",
				},
			});
			await runtime.start();
			const status = await runtime.command("status");
			assert.match(status, /cache-warm: on/);
			assert.match(status, /of 2h/);
			assert.match(status, /rate limit: on/);
			assert.equal(readStored(temp.root), before);
			await runtime.shutdown();

			const fresh = createRuntime();
			await fresh.start();
			const freshStatus = await fresh.command("status");
			assert.match(freshStatus, /cache-warm: off/);
			assert.match(freshStatus, /idle limit: 30m/);
			assert.match(freshStatus, /rate limit: off/);
			await fresh.shutdown();
		} finally {
			temp.cleanup();
		}
	});

	it("atomically lets concurrent same-key writers finish with one complete value", async () => {
		const temp = withAgentDir();
		try {
			const moduleUrl = new URL("../dist/preferences.js", import.meta.url).href;
			const write = (activeMs) => execFileAsync(process.execPath, [
				"--input-type=module", "-e",
				`import { savePreferencesPatch } from ${JSON.stringify(moduleUrl)}; for (let i = 0; i < 12; i++) if (!(await savePreferencesPatch({ activeMs: ${activeMs} }, process.env.PI_CODING_AGENT_DIR))) process.exit(1);`,
			], { env: { ...process.env, PI_CODING_AGENT_DIR: temp.root } });
			await Promise.all([write(45 * 60_000), write(60 * 60_000)]);
			assert.ok([45 * 60_000, 60 * 60_000].includes(loadPreferences(temp.root).activeMs));
			assert.equal(JSON.parse(readFileSync(join(preferencesPath(temp.root), PREFERENCE_FILE_NAMES.activeMs), "utf8")).activeMs, loadPreferences(temp.root).activeMs);
			assert.equal(await savePreferencesPatch({ activeMs: 45 * 60_000 }, temp.root), true);
			assert.equal(await savePreferencesPatch({ activeMs: 60 * 60_000 }, temp.root), true);
			assert.equal(loadPreferences(temp.root).activeMs, 60 * 60_000); // last successful rename wins
			assert.deepEqual(readdirSync(preferencesPath(temp.root)).filter((name) => name.endsWith(".tmp")), []);
		} finally {
			temp.cleanup();
		}
	});

	it("merges different-key edits from concurrent processes without a lock", async () => {
		const temp = withAgentDir();
		const moduleUrl = new URL("../dist/preferences.js", import.meta.url).href;
		const jobs = [
			["activeMs", { activeMs: 45 * 60_000 }],
			["rateLimitEnabled", { rateLimitEnabled: false }],
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
			await waitForFiles(jobs.map((_job, index) => join(temp.root, `ready-${["activeMs", "rateLimitEnabled"][index]}`)));
			await Promise.all(jobs);
			assert.deepEqual(loadPreferences(temp.root), { activeMs: 45 * 60_000, rateLimitEnabled: false });
			assert.equal(existsSync(join(temp.root, "cache-warm.json")), false);
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
			assert.equal(await savePreferencesPatch({ activeMs: 60 * 60_000 }, temp.root), true);
			const readyPath = join(temp.root, "writer-ready");
			const moduleUrl = new URL("../dist/preferences.js", import.meta.url).href;
			const child = spawn(process.execPath, [
				"--input-type=module", "-e",
				`import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
fs.renameSync = () => { fs.writeFileSync(${JSON.stringify(readyPath)}, "ready"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
syncBuiltinESMExports();
const { savePreferencesPatch } = await import(${JSON.stringify(moduleUrl)});
await savePreferencesPatch({ activeMs: ${45 * 60_000} }, ${JSON.stringify(temp.root)});`,
			]);
			await waitForFiles([readyPath]);
			const orphanName = readdirSync(preferencesPath(temp.root)).find((name) => name.startsWith(`.${PREFERENCE_FILE_NAMES.activeMs}.`) && name.endsWith(".tmp"));
			assert.ok(orphanName);
			const orphanPath = join(preferencesPath(temp.root), orphanName);
			child.kill("SIGKILL");
			await new Promise((resolve) => child.once("exit", resolve));
			assert.equal(loadPreferences(temp.root).activeMs, 60 * 60_000);
			assert.equal(await savePreferencesPatch({ activeMs: 45 * 60_000 }, temp.root), true);
			assert.equal(loadPreferences(temp.root).activeMs, 45 * 60_000);
			assert.equal(existsSync(orphanPath), true);
		} finally {
			temp.cleanup();
		}
	});

	it("rejects malformed values and bad input without writing", async () => {
		const temp = withAgentDir();
		try {
			assert.equal(await savePreferencesPatch({ activeMs: DEFAULT_ACTIVE_MS }, temp.root), true);
			writeFileSync(join(preferencesPath(temp.root), PREFERENCE_FILE_NAMES.activeMs), JSON.stringify({ version: 1, activeMs: "45m" }));
			writeFileSync(join(preferencesPath(temp.root), PREFERENCE_FILE_NAMES.rateLimitEnabled), JSON.stringify({ version: 1, rateLimitEnabled: "off" }));
			assert.deepEqual(loadPreferences(temp.root), {});

			const before = readdirSync(preferencesPath(temp.root)).sort();
			assert.equal(await savePreferencesPatch({ activeMs: DEFAULT_ACTIVE_MS, unknown: true }, temp.root), false);
			assert.deepEqual(readdirSync(preferencesPath(temp.root)).sort(), before);

			const blocked = join(temp.root, "not-a-directory");
			writeFileSync(blocked, "occupied");
			assert.equal(await savePreferences({ activeMs: DEFAULT_ACTIVE_MS, rateLimitEnabled: true }, blocked), false);
			assert.deepEqual(readdirSync(preferencesPath(temp.root)).filter((name) => name.endsWith(".tmp")), []);
			assert.equal(await savePreferencesPatch({ activeMs: 45 * 60_000 }, temp.root), true);
			if (process.getuid?.() !== 0) {
				chmodSync(preferencesPath(temp.root), 0o500);
				try {
					assert.equal(await savePreferencesPatch({ activeMs: 60 * 60_000 }, temp.root), false);
					assert.equal(loadPreferences(temp.root).activeMs, 45 * 60_000);
				} finally {
					chmodSync(preferencesPath(temp.root), 0o700);
				}
			}
		} finally {
			temp.cleanup();
		}
	});
});
