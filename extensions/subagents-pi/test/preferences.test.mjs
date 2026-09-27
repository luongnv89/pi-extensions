import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagentsPiExtension from "../dist/index.js";
import { loadPreferences, preferencesPath, savePreferences } from "../dist/preferences.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

function createEventBus() {
	const listeners = new Map();
	return {
		on(name, handler) {
			const handlers = listeners.get(name) ?? new Set();
			handlers.add(handler);
			listeners.set(name, handlers);
			return () => handlers.delete(handler);
		},
	};
}

function createRuntime() {
	const handlers = new Map();
	const commands = new Map();
	const widgets = new Map();
	const statuses = new Map();
	const notifications = [];
	const theme = { fg: (_color, text) => text };
	const context = {
		hasUI: true,
		ui: {
			theme,
			notify(message, level) {
				notifications.push({ message, level });
			},
			setWidget(name, widget) {
				if (widget) widgets.set(name, widget);
				else widgets.delete(name);
			},
			setStatus(name, value) {
				if (value === undefined) statuses.delete(name);
				else statuses.set(name, value);
			},
		},
	};
	const pi = {
		events: createEventBus(),
		on(name, handler) {
			handlers.set(name, handler);
		},
		registerCommand(name, definition) {
			commands.set(name, definition.handler);
		},
	};

	globalThis[MANAGER_KEY] = {
		getRecord: () => undefined,
		hasRunning: () => false,
	};
	subagentsPiExtension(pi);
	return {
		context,
		widgets,
		statuses,
		notifications,
		async start() {
			await handlers.get("session_start")?.({}, context);
		},
		async shutdown() {
			await handlers.get("session_shutdown")?.({}, context);
		},
		async toggle() {
			await commands.get("subagents-pi")(undefined, context);
		},
	};
}

function withAgentDir() {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const root = mkdtempSync(join(tmpdir(), "subagents-pi-preferences-"));
	process.env.PI_CODING_AGENT_DIR = root;
	return {
		root,
		cleanup() {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			delete globalThis[MANAGER_KEY];
			rmSync(root, { recursive: true, force: true });
		},
	};
}

describe("durable subagents-pi toggle", { concurrency: false }, () => {
	it("carries a deliberate toggle from runtime A to a genuinely new runtime B", async () => {
		const temp = withAgentDir();
		try {
			const first = createRuntime();
			await first.start();
			assert.equal(first.widgets.size, 1);
			await first.toggle();
			assert.equal(first.widgets.size, 0);
			assert.equal(JSON.parse(readFileSync(preferencesPath(), "utf8")).enabled, false);
			await first.shutdown();

			const second = createRuntime();
			await second.start();
			assert.equal(second.widgets.size, 0);
			await second.toggle();
			assert.equal(second.widgets.size, 1);
			assert.equal(JSON.parse(readFileSync(preferencesPath(), "utf8")).enabled, true);
			await second.shutdown();
		} finally {
			delete globalThis[MANAGER_KEY];
			temp.cleanup();
		}
	});

	it("validates stale values and cleans up atomic private writes", () => {
		const temp = withAgentDir();
		try {
			writeFileSync(preferencesPath(), JSON.stringify({ version: 4, enabled: true, visibleCount: 12 }));
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
			delete globalThis[MANAGER_KEY];
			temp.cleanup();
		}
	});
});
