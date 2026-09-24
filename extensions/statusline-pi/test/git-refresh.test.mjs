import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import statuslinePiExtension from "../dist/index.js";

// Fake `git` and `gh` binaries that are slow on purpose and log every call, so
// the tests can check that refreshes never block the event loop and that
// bursts of events are coalesced.
const SLOW_MS = 300;
let binDir;
let callLog;
let originalPath;

function writeFakeBinary(name, body) {
	const file = path.join(binDir, name);
	writeFileSync(
		file,
		`#!/bin/sh\necho "${name} $*" >> "${callLog}"\nsleep ${SLOW_MS / 1000}\n${body}\n`,
	);
	chmodSync(file, 0o755);
}

function calls(prefix) {
	let log = "";
	try {
		log = readFileSync(callLog, "utf8");
	} catch {
		return 0;
	}
	return log.split("\n").filter((line) => line.startsWith(prefix)).length;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createHarness() {
	const handlers = new Map();
	let footer;
	const pi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerCommand() {},
		getThinkingLevel() {
			return "off";
		},
	};
	const theme = { fg: (_color, text) => text };
	const ctx = {
		hasUI: true,
		cwd: binDir,
		model: { provider: "test", id: "model", contextWindow: 200_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
		getContextUsage: () => ({ tokens: 0 }),
		sessionManager: { getBranch: () => [] },
		ui: {
			notify() {},
			setFooter(factory) {
				footer = factory?.(
					{ requestRender() {} },
					theme,
					{ onBranchChange: () => () => {}, getGitBranch: () => undefined, getExtensionStatuses: () => new Map() },
				);
			},
		},
	};

	statuslinePiExtension(pi);

	return {
		ctx,
		emit: (event, payload = {}) => handlers.get(event)?.(payload, ctx),
		render: () => footer.render(400).join("\n"),
	};
}

/** Largest delay seen by a 10 ms timer while `fn` runs, in ms beyond its interval. */
async function maxEventLoopStall(fn) {
	let maxGap = 0;
	let last = Date.now();
	const probe = setInterval(() => {
		const now = Date.now();
		maxGap = Math.max(maxGap, now - last - 10);
		last = now;
	}, 10);
	try {
		await fn();
	} finally {
		clearInterval(probe);
	}
	return maxGap;
}

describe("git and PR refresh", () => {
	before(() => {
		binDir = mkdtempSync(path.join(tmpdir(), "statusline-pi-"));
		callLog = path.join(binDir, "calls.log");
		writeFakeBinary(
			"git",
			'case "$1" in branch) echo "feature/x" ;; status) printf " M a\\n M b\\n" ;; *) echo "feature/x" ;; esac',
		);
		writeFakeBinary("gh", "echo 42");
		originalPath = process.env.PATH;
		process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
	});

	after(() => {
		process.env.PATH = originalPath;
		rmSync(binDir, { recursive: true, force: true });
	});

	it("does not block the event loop while git and gh run", async () => {
		const harness = createHarness();
		let startMs = 0;
		const stall = await maxEventLoopStall(async () => {
			const t0 = Date.now();
			await harness.emit("session_start");
			startMs = Date.now() - t0;
			// branch, status and gh run one after another.
			await sleep(SLOW_MS * 6);
		});
		await harness.emit("session_shutdown");

		assert.ok(startMs < SLOW_MS, `session_start took ${startMs} ms`);
		assert.ok(stall < SLOW_MS / 2, `event loop stalled for ${stall} ms`);
		const footer = harness.render();
		assert.match(footer, /feature\/x \[2\] PR #42/);
	});

	it("coalesces a burst of tool results into one git refresh", async () => {
		const harness = createHarness();
		await harness.emit("session_start");
		await sleep(SLOW_MS * 4);
		const statusCallsAfterStart = calls("git status");

		for (let i = 0; i < 20; i++) await harness.emit("tool_result");
		await sleep(1_500 + SLOW_MS * 3);
		await harness.emit("session_shutdown");

		assert.equal(calls("git status") - statusCallsAfterStart, 1);
	});
});
