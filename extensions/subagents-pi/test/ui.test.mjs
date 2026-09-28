import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagentsPiExtension, { preferencesPath } from "../dist/index.js";

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

function createRuntime({ mode = "tui", hasUI = true, selection, omitMode = false } = {}) {
	const handlers = new Map();
	const commands = new Map();
	const widgets = new Map();
	const statuses = new Map();
	const notifications = [];
	const selectCalls = [];
	const theme = { fg: (_color, text) => text };
	const context = {
		mode,
		hasUI,
		ui: {
			theme,
			notify(message, level) {
				notifications.push({ message, level });
			},
			async select(title, options) {
				selectCalls.push({ title, options });
				return typeof selection === "function" ? selection(title, options) : selection;
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
	if (omitMode) delete context.mode;
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
		selectCalls,
		async start() {
			await handlers.get("session_start")?.({}, context);
		},
		async command(args = "") {
			await commands.get("subagents-pi")(args, context);
		},
		async refresh() {
			await commands.get("subagents-pi-refresh")(undefined, context);
		},
		async shutdown() {
			await handlers.get("session_shutdown")?.();
		},
	};
}

function withAgentDir() {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const root = mkdtempSync(join(tmpdir(), "subagents-pi-ui-"));
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

describe("subagents-pi TUI command", { concurrency: false }, () => {
	it("opens a compact menu and leaves the widget and preference untouched on Escape", async () => {
		const temp = withAgentDir();
		try {
			const runtime = createRuntime({ selection: undefined });
			await runtime.start();
			await runtime.command();
			assert.deepEqual(runtime.selectCalls, [
				{
					title: "subagents-pi",
					options: ["Disable subagents-pi (currently enabled)", "Refresh", "Close"],
				},
			]);
			assert.equal(runtime.widgets.size, 1);
			assert.equal(runtime.statuses.get("subagents-pi"), "subagents:0");
			assert.equal(existsSync(preferencesPath()), false);
			await runtime.shutdown();
		} finally {
			temp.cleanup();
		}
	});

	it("persists menu changes, updates active effects, and skips the menu for explicit commands", async () => {
		const temp = withAgentDir();
		try {
			const runtime = createRuntime({ selection: "Disable subagents-pi (currently enabled)" });
			await runtime.start();
			await runtime.command();
			assert.equal(JSON.parse(readFileSync(preferencesPath(), "utf8")).enabled, false);
			assert.equal(runtime.widgets.size, 0);
			assert.equal(runtime.statuses.has("subagents-pi"), false);
			const menuCount = runtime.selectCalls.length;

			await runtime.command("on");
			assert.equal(runtime.selectCalls.length, menuCount);
			assert.equal(runtime.widgets.size, 1);
			assert.equal(runtime.statuses.get("subagents-pi"), "subagents:0");
			assert.equal(JSON.parse(readFileSync(preferencesPath(), "utf8")).enabled, true);
			await runtime.command("off");
			assert.equal(runtime.selectCalls.length, menuCount);
			assert.equal(runtime.widgets.size, 0);
			await runtime.shutdown();
		} finally {
			temp.cleanup();
		}
	});

	it("keeps the historical bare toggle outside TUI and preserves refresh", async () => {
		const temp = withAgentDir();
		try {
			const runtime = createRuntime({ mode: "rpc" });
			await runtime.start();
			await runtime.command();
			assert.equal(runtime.selectCalls.length, 0);
			assert.equal(JSON.parse(readFileSync(preferencesPath(), "utf8")).enabled, false);
			await runtime.refresh();
			assert.match(runtime.notifications.at(-1).message, /refreshed/);
			await runtime.shutdown();
		} finally {
			temp.cleanup();
		}
	});

	it("does not open a menu when mode is absent or UI is unavailable", async () => {
		for (const options of [{ omitMode: true }, { mode: "tui", hasUI: false }]) {
			const temp = withAgentDir();
			try {
				const runtime = createRuntime(options);
				await runtime.start();
				await runtime.command();
				assert.equal(runtime.selectCalls.length, 0);
				if (options.hasUI === false) {
					assert.equal(existsSync(preferencesPath()), false, "headless commands must not change preferences");
				}
				await runtime.shutdown();
			} finally {
				temp.cleanup();
			}
		}
	});
});
