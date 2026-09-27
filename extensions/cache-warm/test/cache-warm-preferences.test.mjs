import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cacheWarmExtension, {
	DEFAULT_ACTIVE_MS,
	loadPreferences,
	preferencesLockPath,
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
	return readFileSync(join(root, "cache-warm.json"), "utf8");
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
			assert.equal(existsSync(preferencesPath()), false);
			await first.command("rate off");
			assert.deepEqual(JSON.parse(readStored(temp.root)), { version: 1, rateLimitEnabled: false });
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
			assert.equal(stored.version, 1);
			assert.equal(stored.activeMs, 45 * 60_000);
			assert.equal(stored.rateLimitEnabled, false);
			assert.equal("enabled" in stored, false);
			assert.equal(statSync(preferencesPath()).mode & 0o077, 0);
			assert.deepEqual(readdirSync(temp.root).filter((name) => name.endsWith(".tmp")), []);

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

	it("merges different-key edits from two processes after a shared lock gate", async () => {
		const temp = withAgentDir();
		const lockPath = preferencesLockPath(temp.root);
		mkdirSync(lockPath, { mode: 0o700 });
		let parentOwnsLock = true;
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
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(existsSync(preferencesPath(temp.root)), false);
			assert.equal(existsSync(lockPath), true);
			rmdirSync(lockPath);
			parentOwnsLock = false;
			await Promise.all(jobs);
			assert.deepEqual(JSON.parse(readStored(temp.root)), {
				version: 1,
				activeMs: 45 * 60_000,
				rateLimitEnabled: false,
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
				`import { savePreferencesPatch } from ${JSON.stringify(moduleUrl)}; process.stdout.write(String(await savePreferencesPatch({ activeMs: 45 * 60_000 }, process.env.PI_CODING_AGENT_DIR)));`,
			], {
				env: { ...process.env, PI_CODING_AGENT_DIR: temp.root },
				timeout: 4_000,
			});
			assert.equal(result.stdout.trim(), "false");
			assert.equal(existsSync(lockPath), true);
			assert.deepEqual(readdirSync(temp.root).filter((name) => name.endsWith(".tmp")), []);

			rmSync(lockPath, { recursive: true, force: true });
			mkdirSync(preferencesPath(temp.root));
			assert.equal(await savePreferencesPatch({ activeMs: 45 * 60_000 }, temp.root), false);
			assert.equal(existsSync(lockPath), false);
			assert.deepEqual(readdirSync(temp.root).filter((name) => name.endsWith(".tmp")), []);

			rmSync(preferencesPath(temp.root), { recursive: true, force: true });
			assert.equal(await savePreferencesPatch({ activeMs: 45 * 60_000 }, temp.root), true);
			assert.equal(existsSync(lockPath), false);
		} finally {
			rmSync(lockPath, { recursive: true, force: true });
			temp.cleanup();
		}
	});

	it("rejects malformed values and fails closed when the preferences path cannot be written", async () => {
		const temp = withAgentDir();
		try {
			writeFileSync(preferencesPath(), JSON.stringify({ version: 1, activeMs: "45m", rateLimitEnabled: "off" }));
			assert.deepEqual(loadPreferences(), {});
			const blocked = join(temp.root, "not-a-directory");
			writeFileSync(blocked, "occupied");
			assert.equal(await savePreferences({ version: 1, activeMs: DEFAULT_ACTIVE_MS, rateLimitEnabled: true }, blocked), false);
		} finally {
			temp.cleanup();
		}
	});
});
