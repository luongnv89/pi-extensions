import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import timestampPiExtension from "../dist/index.js";
import { loadPreferences, preferencesPath, savePreferences } from "../dist/preferences.js";

function createRuntime() {
	const handlers = new Map();
	const commands = new Map();
	let renderer;
	const entries = [];
	const notifications = [];
	const context = {
		hasUI: true,
		ui: {
			theme: { fg: (_color, text) => text },
			notify(message, level) {
				notifications.push({ message, level });
			},
			setStatus() {},
		},
		sessionManager: {
			getEntries() {
				return entries;
			},
		},
	};
	const pi = {
		on(name, handler) {
			handlers.set(name, handler);
		},
		registerCommand(name, definition) {
			commands.set(name, definition.handler);
		},
		registerEntryRenderer(_type, handler) {
			renderer = handler;
		},
		appendEntry(customType, data) {
			entries.push({ type: "custom", customType, data });
		},
	};

	timestampPiExtension(pi);
	return {
		context,
		entries,
		notifications,
		render(entry) {
			return renderer(entry, {}, context.ui.theme);
		},
		async start() {
			await handlers.get("session_start")?.({}, context);
		},
		async shutdown() {
			await handlers.get("session_shutdown")?.({}, context);
		},
		async toggle() {
			await commands.get("timestamp-pi")(undefined, context);
		},
		async message(message) {
			await handlers.get("message_end")?.({ message }, context);
		},
	};
}

function withAgentDir() {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const root = mkdtempSync(join(tmpdir(), "timestamp-pi-preferences-"));
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

describe("durable timestamp-pi toggle", { concurrency: false }, () => {
	it("carries a deliberate toggle from runtime A to a genuinely new runtime B", async () => {
		const temp = withAgentDir();
		try {
			const first = createRuntime();
			await first.start();
			await first.message({ role: "user", timestamp: 1000 });
			assert.equal(first.entries.length, 1);
			await first.toggle();
			assert.equal(first.render({ data: first.entries[0].data }), undefined);
			await first.message({ role: "user", timestamp: 2000 });
			assert.equal(first.entries.length, 1);
			assert.equal(JSON.parse(readFileSync(preferencesPath(), "utf8")).enabled, false);
			await first.shutdown();

			const second = createRuntime();
			await second.start();
			assert.equal(second.render({ data: { role: "user", timestamp: 3000 } }), undefined);
			await second.message({ role: "user", timestamp: 3000 });
			assert.equal(second.entries.length, 0);
			await second.shutdown();
		} finally {
			temp.cleanup();
		}
	});

	it("validates stale values and cleans up atomic private writes", () => {
		const temp = withAgentDir();
		try {
			writeFileSync(preferencesPath(), JSON.stringify({ version: 7, enabled: true, cacheLastActive: 123 }));
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
