import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import timestampPiExtension, { preferencesPath } from "../dist/index.js";

function createRuntime({ mode = "tui", hasUI = true, selection, omitMode = false } = {}) {
	const handlers = new Map();
	const commands = new Map();
	const entries = [];
	const statuses = new Map();
	const notifications = [];
	const selectCalls = [];
	let renderer;
	const context = {
		mode,
		hasUI,
		sessionManager: {
			getEntries() {
				return entries;
			},
		},
		ui: {
			theme: { fg: (_color, text) => text },
			notify(message, level) {
				notifications.push({ message, level });
			},
			setStatus(name, value) {
				if (value === undefined) statuses.delete(name);
				else statuses.set(name, value);
			},
			async select(title, options) {
				selectCalls.push({ title, options });
				return typeof selection === "function" ? selection(title, options) : selection;
			},
		},
	};
	if (omitMode) delete context.mode;
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
		statuses,
		notifications,
		selectCalls,
		render(entry) {
			return renderer(entry, {}, context.ui.theme);
		},
		async start() {
			await handlers.get("session_start")?.({}, context);
		},
		async command(args = "") {
			await commands.get("timestamp-pi")(args, context);
		},
		async message(message) {
			await handlers.get("message_end")?.({ message }, context);
		},
		async shutdown() {
			await handlers.get("session_shutdown")?.({}, context);
		},
	};
}

function withAgentDir() {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const root = mkdtempSync(join(tmpdir(), "timestamp-pi-ui-"));
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

describe("timestamp-pi TUI command", { concurrency: false }, () => {
	it("cancelling the menu does not persist or change timestamp behavior", async () => {
		const temp = withAgentDir();
		try {
			const runtime = createRuntime({ selection: undefined });
			await runtime.start();
			await runtime.command();
			assert.deepEqual(runtime.selectCalls, [
				{
					title: "timestamp-pi",
					options: ["Disable timestamp-pi (currently enabled)", "Close"],
				},
			]);
			assert.equal(existsSync(preferencesPath()), false);
			await runtime.message({ role: "user", timestamp: 1000 });
			assert.equal(runtime.entries.length, 1);
			await runtime.shutdown();
		} finally {
			temp.cleanup();
		}
	});

	it("applies menu and explicit on/off changes through the normal mount path", async () => {
		const temp = withAgentDir();
		try {
			const runtime = createRuntime({ selection: "Disable timestamp-pi (currently enabled)" });
			await runtime.start();
			await runtime.command();
			assert.equal(JSON.parse(readFileSync(preferencesPath(), "utf8")).enabled, false);
			await runtime.message({ role: "user", timestamp: 1000 });
			assert.equal(runtime.entries.length, 0);
			assert.equal(runtime.render({ data: { role: "user", timestamp: 1000 } }), undefined);
			const menuCount = runtime.selectCalls.length;

			await runtime.command("on");
			assert.equal(runtime.selectCalls.length, menuCount);
			await runtime.message({ role: "user", timestamp: 2000 });
			assert.equal(runtime.entries.length, 1);
			assert.equal(JSON.parse(readFileSync(preferencesPath(), "utf8")).enabled, true);
			await runtime.command("off");
			assert.equal(runtime.selectCalls.length, menuCount);
			await runtime.shutdown();
		} finally {
			temp.cleanup();
		}
	});

	it("keeps the historical bare toggle outside TUI", async () => {
		const temp = withAgentDir();
		try {
			const runtime = createRuntime({ mode: "rpc" });
			await runtime.start();
			await runtime.command();
			assert.equal(runtime.selectCalls.length, 0);
			assert.equal(JSON.parse(readFileSync(preferencesPath(), "utf8")).enabled, false);
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
				await runtime.shutdown();
			} finally {
				temp.cleanup();
			}
		}
	});
});
