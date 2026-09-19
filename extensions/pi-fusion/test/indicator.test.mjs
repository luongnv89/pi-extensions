import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	formatIdleStatus,
	formatRunningStatus,
	formatWorkingMessage,
	shortModelName,
	showIdle,
	showRunning,
	STATUS_KEY,
} from "../dist/indicator.js";

// Print mode sets ctx.hasUI false, so none of this runs during a benchmark or a
// scripted session. A stub stands in for the terminal.
function stubUi() {
	const calls = { working: [], status: [], colors: [] };
	return {
		calls,
		setWorkingMessage: (message) => calls.working.push(message),
		setStatus: (key, text) => calls.status.push([key, text]),
		theme: {
			fg: (color, text) => {
				calls.colors.push(color);
				return text;
			},
		},
	};
}

const LUNA = { provider: "openai-codex", modelId: "gpt-5.6-luna" };
const SOL = { provider: "openai-codex", modelId: "gpt-5.6-sol" };
const HAIKU = { provider: "openrouter", modelId: "anthropic/claude-haiku-4.5" };

describe("formatWorkingMessage", () => {
	it("names the executing model in full, with progress and elapsed time", () => {
		const text = formatWorkingMessage({ spec: LUNA, delegationIndex: 2, maxDelegations: 25, elapsedMs: 12_400 });
		assert.equal(text, "Sidekick openai-codex/gpt-5.6-luna · delegation 2/25 · 12s");
	});

	it("keeps the provider so two models with the same name are distinguishable", () => {
		const text = formatWorkingMessage({ spec: HAIKU, delegationIndex: 1, maxDelegations: 10, elapsedMs: 0 });
		assert.match(text, /openrouter\/anthropic\/claude-haiku-4\.5/);
	});
});

describe("formatRunningStatus", () => {
	it("marks the running model and ticks in whole seconds", () => {
		assert.equal(formatRunningStatus({ spec: LUNA, delegationIndex: 1, maxDelegations: 25, elapsedMs: 0 }), "fusion ▸ gpt-5.6-luna 0s");
		assert.equal(formatRunningStatus({ spec: LUNA, delegationIndex: 1, maxDelegations: 25, elapsedMs: 9_600 }), "fusion ▸ gpt-5.6-luna 10s");
	});

	it("never shows a negative timer if the clock jumps", () => {
		assert.match(formatRunningStatus({ spec: LUNA, delegationIndex: 1, maxDelegations: 25, elapsedMs: -5000 }), /0s$/);
	});
});

describe("formatIdleStatus", () => {
	const base = { sidekick: LUNA, delegations: 0, maxDelegations: 25, saved: 0, struggling: false };

	it("shows the configured sidekick and budget", () => {
		assert.equal(formatIdleStatus(base), "fusion sk:gpt-5.6-luna 0/25");
	});

	it("adds savings only once something has been delegated", () => {
		assert.equal(formatIdleStatus({ ...base, saved: 0.042 }), "fusion sk:gpt-5.6-luna 0/25");
		assert.equal(formatIdleStatus({ ...base, delegations: 3, saved: 0.042 }), "fusion sk:gpt-5.6-luna 3/25 ~$0.04");
	});

	it("surfaces an escalated main model so a silent swap cannot go unnoticed", () => {
		assert.equal(formatIdleStatus({ ...base, escalatedMain: SOL }), "fusion ↑gpt-5.6-sol sk:gpt-5.6-luna 0/25");
	});
});

describe("showRunning / showIdle", () => {
	it("sets both the working row and the footer while delegating", () => {
		const ui = stubUi();
		showRunning(ui, { spec: LUNA, delegationIndex: 1, maxDelegations: 25, elapsedMs: 3000 });
		assert.equal(ui.calls.working.length, 1);
		assert.match(ui.calls.working[0], /Sidekick openai-codex\/gpt-5\.6-luna/);
		assert.deepEqual(ui.calls.status[0], [STATUS_KEY, "fusion ▸ gpt-5.6-luna 3s"]);
		assert.deepEqual(ui.calls.colors, ["accent"]);
	});

	it("restores the default working row when the delegation ends", () => {
		const ui = stubUi();
		showIdle(ui, { sidekick: LUNA, delegations: 1, maxDelegations: 25, saved: 0, struggling: false });
		assert.deepEqual(ui.calls.working, [undefined]);
		assert.equal(ui.calls.status[0][1], "fusion sk:gpt-5.6-luna 1/25");
	});

	it("clears the footer but still restores the working row when disabled", () => {
		const ui = stubUi();
		showIdle(ui, undefined);
		assert.deepEqual(ui.calls.working, [undefined]);
		assert.deepEqual(ui.calls.status, [[STATUS_KEY, undefined]]);
	});

	it("warns in colour after a failed delegation", () => {
		const ui = stubUi();
		showIdle(ui, { sidekick: LUNA, delegations: 2, maxDelegations: 25, saved: 0, struggling: true });
		assert.deepEqual(ui.calls.colors, ["warning"]);
	});

	it("is a no-op without a UI, as in print mode", () => {
		assert.doesNotThrow(() => showRunning(undefined, { spec: LUNA, delegationIndex: 1, maxDelegations: 2, elapsedMs: 0 }));
		assert.doesNotThrow(() => showIdle(undefined, undefined));
	});
});

describe("shortModelName", () => {
	it("drops the provider and any vendor path prefix", () => {
		assert.equal(shortModelName(LUNA), "gpt-5.6-luna");
		assert.equal(shortModelName(HAIKU), "claude-haiku-4.5");
		assert.equal(shortModelName({ provider: "groq", modelId: "openai/gpt-oss-20b" }), "gpt-oss-20b");
		assert.equal(shortModelName(undefined), "none");
	});
});
