import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, defaultStats } from "../dist/config.js";
import { buildMainAgentGuidance } from "../dist/index.js";
import { buildDelegationPrompt, lastAssistantFailure, sidekickKey, SIDEKICK_SYSTEM_PROMPT, truncate } from "../dist/sidekick.js";

describe("buildDelegationPrompt", () => {
	it("sends the task alone when nothing else is supplied", () => {
		const prompt = buildDelegationPrompt({ task: "Run the test suite" }, 1000);
		assert.equal(prompt, "## Task\nRun the test suite");
	});

	it("includes context and expectations when given", () => {
		const prompt = buildDelegationPrompt(
			{ task: "Remove OpenTracing", context: "Plan: delete the middleware first", expect: "List every file touched" },
			1000,
		);
		assert.match(prompt, /## Context from the main agent/);
		assert.match(prompt, /Plan: delete the middleware first/);
		assert.match(prompt, /## What to report back/);
	});

	it("skips blank optional sections", () => {
		const prompt = buildDelegationPrompt({ task: "x", context: "   ", expect: "" }, 1000);
		assert.ok(!prompt.includes("## Context from the main agent"));
		assert.ok(!prompt.includes("## What to report back"));
	});

	it("caps oversized tasks", () => {
		const prompt = buildDelegationPrompt({ task: "a".repeat(100) }, 10);
		assert.match(prompt, /truncated 90 characters/);
	});
});

describe("truncate", () => {
	it("leaves text under the cap alone", () => {
		assert.equal(truncate("short", 100), "short");
		assert.equal(truncate("short", 0), "short");
	});
});

describe("sidekickKey", () => {
	it("changes when the model, tool mode, or thinking level changes", () => {
		const spec = { provider: "groq", modelId: "llama-3.1-8b-instant" };
		const base = sidekickKey(spec, "readonly", "low");
		assert.notEqual(base, sidekickKey(spec, "coding", "low"));
		assert.notEqual(base, sidekickKey(spec, "readonly", "high"));
		assert.notEqual(base, sidekickKey({ provider: "xai", modelId: "grok-4" }, "readonly", "low"));
		assert.equal(base, sidekickKey({ ...spec }, "readonly", "low"));
	});
});

describe("lastAssistantFailure", () => {
	it("surfaces an errored turn that resolved without throwing", () => {
		const session = {
			messages: [
				{ role: "user" },
				{ role: "assistant", stopReason: "error", errorMessage: "404: model not found" },
			],
		};
		assert.equal(lastAssistantFailure(session), "404: model not found");
	});

	it("reports an abort", () => {
		const session = { messages: [{ role: "assistant", stopReason: "aborted" }] };
		assert.match(lastAssistantFailure(session), /aborted/);
	});

	it("only inspects the most recent assistant turn", () => {
		const session = {
			messages: [
				{ role: "assistant", stopReason: "error", errorMessage: "old failure" },
				{ role: "user" },
				{ role: "assistant", stopReason: "stop" },
			],
		};
		assert.equal(lastAssistantFailure(session), undefined);
	});

	it("returns undefined when no assistant turn exists yet", () => {
		assert.equal(lastAssistantFailure({ messages: [{ role: "user" }] }), undefined);
	});
});

describe("prompts", () => {
	it("tells the sidekick to flag ambiguity instead of guessing", () => {
		assert.match(SIDEKICK_SYSTEM_PROMPT, /Do not silently guess a judgment call/);
	});

	it("tells the main agent to keep the judgment calls", () => {
		const guidance = buildMainAgentGuidance(defaultConfig(), defaultStats());
		assert.match(guidance, /the plan, the interpretation of ambiguity, and the final review/);
		assert.match(guidance, /do the work yourself/);
	});

	it("sets the delegation floor by output volume, not step count", () => {
		const guidance = buildMainAgentGuidance(defaultConfig(), defaultStats());
		// A single command printing hundreds of lines is the case worth delegating;
		// an earlier "one or two tool calls" rule wrongly excluded exactly that.
		assert.match(guidance, /how much output/);
		assert.match(guidance, /hundreds of lines/);
		assert.ok(!/one or two tool calls/.test(guidance));
	});

	it("says the sidekick is read-only when it is", () => {
		assert.match(buildMainAgentGuidance(defaultConfig(), defaultStats()), /read-only/);
		const coding = { ...defaultConfig(), toolMode: "coding" };
		assert.ok(!buildMainAgentGuidance(coding, defaultStats()).includes("read-only"));
	});

	it("stays small: it is re-sent on every turn", () => {
		// Guard against the fixed per-turn overhead creeping back up.
		const guidance = buildMainAgentGuidance(defaultConfig(), defaultStats());
		assert.ok(guidance.length < 700, `guidance grew to ${guidance.length} chars`);
	});
});

