import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import statuslinePiExtension, { preferencesPath } from "../dist/index.js";

function createRuntime({ mode = "tui", hasUI = true, selection, omitMode = false } = {}) {
	const handlers = new Map();
	const commands = new Map();
	const footerValues = [];
	const notifications = [];
	const selectCalls = [];
	const context = {
		mode,
		hasUI,
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
	};

	statuslinePiExtension(pi);
	return {
		context,
		footerValues,
		notifications,
		selectCalls,
		async start() {
			await handlers.get("session_start")?.({}, context);
		},
		async command(args = "") {
			await commands.get("statusline-pi")(args, context);
		},
		async refresh() {
			await commands.get("statusline-refresh")(undefined, context);
		},
		async shutdown() {
			await handlers.get("session_shutdown")?.({}, context);
		},
	};
}

function withAgentDir() {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const root = mkdtempSync(join(tmpdir(), "statusline-pi-ui-"));
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

describe("statusline-pi TUI command", { concurrency: false }, () => {
	it("opens a compact menu and leaves state untouched on Escape", async () => {
		const temp = withAgentDir();
		try {
			const runtime = createRuntime({ selection: undefined });
			await runtime.start();
			await runtime.command();

			assert.deepEqual(runtime.selectCalls, [
				{
					title: "statusline-pi",
					options: ["Disable statusline-pi (currently enabled)", "Refresh", "Close"],
				},
			]);
			assert.equal(runtime.footerValues.length, 1);
			assert.equal(existsSync(preferencesPath()), false);
			await runtime.shutdown();
		} finally {
			temp.cleanup();
		}
	});

	it("persists menu changes, updates the footer, and keeps explicit commands out of the menu", async () => {
		const temp = withAgentDir();
		try {
			const runtime = createRuntime({ selection: "Disable statusline-pi (currently enabled)" });
			await runtime.start();
			await runtime.command();
			assert.equal(JSON.parse(readFileSync(preferencesPath(), "utf8")).enabled, false);
			assert.equal(runtime.footerValues.at(-1), undefined);
			const menuCount = runtime.selectCalls.length;

			await runtime.command("on");
			assert.equal(runtime.selectCalls.length, menuCount);
			assert.equal(runtime.footerValues.at(-1) instanceof Function, true);
			assert.equal(JSON.parse(readFileSync(preferencesPath(), "utf8")).enabled, true);
			await runtime.shutdown();
		} finally {
			temp.cleanup();
		}
	});

	it("falls back to the historical bare toggle outside TUI and preserves refresh", async () => {
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
