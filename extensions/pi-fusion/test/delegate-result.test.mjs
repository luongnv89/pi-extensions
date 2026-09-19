import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import piFusionExtension from "../dist/index.js";
import {
	DELEGATE_TRUNCATION_NOTICE,
	aggregateAssistantUsage,
	isFailedDelegateDetails,
	truncateDelegateContent,
} from "../dist/delegate-result.js";

function usage(overrides = {}) {
	return {
		input: 10,
		output: 20,
		cacheRead: 3,
		cacheWrite: 4,
		totalTokens: 37,
		cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 },
		...overrides,
	};
}

describe("aggregateAssistantUsage", () => {
	it("combines only newly supplied assistant usage and preserves optional fields", () => {
		assert.deepEqual(
			aggregateAssistantUsage([
				{ role: "user", usage: usage({ input: 999 }) },
				{ role: "assistant", usage: usage({ cacheWrite1h: 2, reasoning: 5 }) },
				{ role: "toolResult", usage: usage({ input: 999 }) },
				{ role: "assistant", usage: usage({ cacheWrite1h: 3, reasoning: 7 }) },
			]),
			{
				input: 20,
				output: 40,
				cacheRead: 6,
				cacheWrite: 8,
				cacheWrite1h: 5,
				reasoning: 12,
				totalTokens: 74,
				cost: { input: 0.02, output: 0.04, cacheRead: 0.006, cacheWrite: 0.008, total: 0.074 },
			},
		);
	});

	it("returns undefined when no assistant message has actual usage", () => {
		assert.equal(aggregateAssistantUsage([{ role: "user" }, { role: "assistant" }, { role: "toolResult" }]), undefined);
	});
});

describe("truncateDelegateContent", () => {
	it("caps oversized UTF-8 output in bytes and keeps a complete notice", () => {
		const fullText = `${"界".repeat(DEFAULT_MAX_BYTES)}\nfooter`;
		const result = truncateDelegateContent(fullText);

		assert.equal(result.fullText, fullText);
		assert.equal(result.truncated, true);
		assert.ok(Buffer.byteLength(result.text, "utf8") <= DEFAULT_MAX_BYTES);
		assert.ok(result.text.includes(DELEGATE_TRUNCATION_NOTICE));
	});

	it("caps oversized output in lines and marks the model-facing text", () => {
		const fullText = Array.from({ length: DEFAULT_MAX_LINES + 100 }, (_, index) => `line ${index}`).join("\n");
		const result = truncateDelegateContent(fullText);

		assert.equal(result.truncated, true);
		assert.ok(result.text.split("\n").length <= DEFAULT_MAX_LINES);
		assert.ok(result.text.includes(DELEGATE_TRUNCATION_NOTICE));
		assert.equal(result.fullText, fullText);
	});
});

describe("isFailedDelegateDetails", () => {
	it("accepts only an explicit false fusion result", () => {
		assert.equal(isFailedDelegateDetails({ fusion: { ok: false } }), true);
		assert.equal(isFailedDelegateDetails({ fusion: { ok: true } }), false);
		assert.equal(isFailedDelegateDetails({ fusion: {} }), false);
		assert.equal(isFailedDelegateDetails({ fusion: { ok: 0 } }), false);
		assert.equal(isFailedDelegateDetails(undefined), false);
	});

	it("marks only failed delegate results as errors through the registered middleware", async () => {
		const handlers = new Map();
		piFusionExtension({
			registerFlag() {},
			registerTool() {},
			registerCommand() {},
			on(name, handler) {
				handlers.set(name, handler);
			},
		});
		const handler = handlers.get("tool_result");

		assert.deepEqual(await handler({ toolName: "delegate", details: { fusion: { ok: false } } }), { isError: true });
		assert.equal(await handler({ toolName: "delegate", details: { fusion: { ok: true } } }), undefined);
		assert.equal(await handler({ toolName: "other", details: { fusion: { ok: false } } }), undefined);
	});
});
