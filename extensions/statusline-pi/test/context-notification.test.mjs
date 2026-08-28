import { describe, it } from "node:test";
import assert from "node:assert/strict";
import statuslinePiExtension, {
	GPT_CONTEXT_PRICE_BREAKPOINT_TOKENS,
	formatGptContextBreakpointNotice,
	isGptModel,
	shouldNotifyGptContextBreakpoint,
} from "../dist/index.js";

function createHarness({ model = { provider: "openai", id: "gpt-5.5", contextWindow: 1_000_000 }, tokens = 0 } = {}) {
	const handlers = new Map();
	const notifications = [];
	let usedTokens = tokens;
	const resolvedModel = model === undefined
		? undefined
		: {
			...model,
			cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
	const pi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerCommand() {},
		getThinkingLevel() {
			return "off";
		},
	};
	const ctx = {
		hasUI: true,
		model: resolvedModel,
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
		},
		getContextUsage() {
			return usedTokens === undefined ? undefined : { tokens: usedTokens };
		},
		sessionManager: {
			getBranch() {
				return [];
			},
		},
	};

	statuslinePiExtension(pi);

	return {
		ctx,
		notifications,
		messageEnd: handlers.get("message_end"),
		setTokens(value) {
			usedTokens = value;
		},
	};
}

function assistantMessage() {
	return {
		role: "assistant",
		content: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

describe("GPT context pricing breakpoint", () => {
	it("recognizes OpenAI GPT models and excludes other model families", () => {
		assert.equal(isGptModel({ provider: "openai", id: "gpt-5.5" }), true);
		assert.equal(isGptModel({ provider: "openai-codex", id: "models/gpt-5.6-sol" }), true);
		assert.equal(isGptModel({ provider: "anthropic", id: "claude-sonnet-4" }), false);
		assert.equal(isGptModel({ provider: "openai", id: "o3" }), false);
		assert.equal(isGptModel(undefined), false);
	});

	it("notifies at the threshold but not below it or twice for the same crossing", () => {
		const model = { provider: "openai", id: "gpt-5.5" };

		assert.equal(shouldNotifyGptContextBreakpoint(model, GPT_CONTEXT_PRICE_BREAKPOINT_TOKENS - 1, false), false);
		assert.equal(shouldNotifyGptContextBreakpoint(model, GPT_CONTEXT_PRICE_BREAKPOINT_TOKENS, false), true);
		assert.equal(shouldNotifyGptContextBreakpoint(model, GPT_CONTEXT_PRICE_BREAKPOINT_TOKENS + 1, true), false);
		assert.equal(shouldNotifyGptContextBreakpoint(undefined, GPT_CONTEXT_PRICE_BREAKPOINT_TOKENS, false), false);
		assert.equal(shouldNotifyGptContextBreakpoint(model, Number.NaN, false), false);
	});

	it("describes the threshold and doubled-price impact", () => {
		assert.match(formatGptContextBreakpointNotice(), /272,000/);
		assert.match(formatGptContextBreakpointNotice(), /pricing breakpoint/);
		assert.match(formatGptContextBreakpointNotice(), /costs double/);
	});

	it("notifies once for repeated events and allows a later threshold crossing", async () => {
		const harness = createHarness({ tokens: GPT_CONTEXT_PRICE_BREAKPOINT_TOKENS - 1 });

		await harness.messageEnd({ message: assistantMessage() }, harness.ctx);
		harness.setTokens(GPT_CONTEXT_PRICE_BREAKPOINT_TOKENS);
		await harness.messageEnd({ message: assistantMessage() }, harness.ctx);
		harness.setTokens(GPT_CONTEXT_PRICE_BREAKPOINT_TOKENS + 1);
		await harness.messageEnd({ message: assistantMessage() }, harness.ctx);

		assert.equal(harness.notifications.length, 1);
		assert.equal(harness.notifications[0].type, "warning");
		assert.match(harness.notifications[0].message, /272,000/);
		assert.match(harness.notifications[0].message, /costs double/);

		harness.setTokens(0);
		await harness.messageEnd({ message: assistantMessage() }, harness.ctx);
		harness.setTokens(GPT_CONTEXT_PRICE_BREAKPOINT_TOKENS);
		await harness.messageEnd({ message: assistantMessage() }, harness.ctx);
		assert.equal(harness.notifications.length, 2);
	});

	it("does not notify for non-GPT or missing model/usage metadata", async () => {
		const nonGpt = createHarness({ model: { provider: "anthropic", id: "claude-sonnet-4" }, tokens: GPT_CONTEXT_PRICE_BREAKPOINT_TOKENS });
		await nonGpt.messageEnd({ message: assistantMessage() }, nonGpt.ctx);
		assert.deepEqual(nonGpt.notifications, []);

		const missingMetadata = createHarness({ model: undefined, tokens: undefined });
		await missingMetadata.messageEnd({ message: assistantMessage() }, missingMetadata.ctx);
		assert.deepEqual(missingMetadata.notifications, []);
	});
});
