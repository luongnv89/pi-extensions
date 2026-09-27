import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import statuslinePiExtension from "../dist/index.js";
import { loadPreferences, preferencesPath, savePreferences } from "../dist/preferences.js";

function createRuntime() {
	const handlers = new Map();
	const commands = new Map();
	const footerValues = [];
	const notifications = [];
	const pi = {
		on(name, handler) {
			handlers.set(name, handler);
		},
		registerCommand(name, definition) {
			commands.set(name, definition.handler);
		},
	};
	const context = {
		hasUI: true,
		cwd: "/tmp",
		model: {
			provider: "openai",
			id: "gpt-test",
			contextWindow: 128_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
		getContextUsage() {
			return { tokens: 0 };
		},
		sessionManager: {
			getBranch() {
				return [];
			},
		},
		ui: {
			setFooter(value) {
				footerValues.push(value);
			},
			notify(message, level) {
				notifications.push({ message, level });
			},
		},
	};

	statuslinePiExtension(pi);
	return {
		context,
		footerValues,
		notifications,
		async start() {
			await handlers.get("session_start")?.({}, context);
		},
		async shutdown() {
			await handlers.get("session_shutdown")?.({}, context);
		},
		async toggle() {
			await commands.get("statusline-pi")(undefined, context);
		},
	};
}

function withAgentDir() {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const root = mkdtempSync(join(tmpdir(), "statusline-pi-preferences-"));
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

describe("durable statusline-pi toggle", { concurrency: false }, () => {
	it("carries a deliberate toggle from runtime A to a genuinely new runtime B", async () => {
		const temp = withAgentDir();
		try {
			const first = createRuntime();
			await first.start();
			assert.equal(first.footerValues.length, 1);
			await first.toggle();
			assert.equal(JSON.parse(readFileSync(preferencesPath(), "utf8")).enabled, false);
			await first.shutdown();

			const second = createRuntime();
			await second.start();
			assert.equal(second.footerValues.length, 0);
			await second.toggle();
			assert.equal(second.footerValues.length, 1);
			assert.equal(JSON.parse(readFileSync(preferencesPath(), "utf8")).enabled, true);
			await second.shutdown();
		} finally {
			temp.cleanup();
		}
	});

	it("validates stale values and cleans up atomic private writes", () => {
		const temp = withAgentDir();
		try {
			writeFileSync(preferencesPath(), JSON.stringify({ version: 99, enabled: false, sessionCost: 42 }));
			assert.deepEqual(loadPreferences(), {});
			assert.equal(savePreferences(false), true);
			assert.deepEqual(loadPreferences(), { enabled: false });
			assert.deepEqual(Object.keys(JSON.parse(readFileSync(preferencesPath(), "utf8"))).sort(), ["enabled", "version"]);
			assert.equal(statSync(preferencesPath()).mode & 0o077, 0);
			assert.deepEqual(readdirSync(temp.root).filter((name) => name.endsWith(".tmp")), []);

			const blocked = join(temp.root, "not-a-directory");
			writeFileSync(blocked, "occupied");
			assert.equal(savePreferences(true, blocked), false);
		} finally {
			temp.cleanup();
		}
	});
});
