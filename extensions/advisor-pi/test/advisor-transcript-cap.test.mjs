import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAX_TRANSCRIPT_CHARS, defaultConfig, normalizeConfig, truncateTranscript } from "../dist/index.js";

const fallback = defaultConfig();

describe("truncateTranscript", () => {
	it("returns short transcripts unchanged", () => {
		assert.equal(truncateTranscript("hello", 100), "hello");
		assert.equal(truncateTranscript("hello", 5), "hello");
	});

	it("keeps the most recent characters and marks truncation", () => {
		const text = "A".repeat(50) + "RECENT";
		const out = truncateTranscript(text, 10);
		assert.ok(out.includes("truncated"), "should say it truncated");
		assert.equal(out.endsWith(text.slice(-10)), true);
		assert.ok(!out.includes("A".repeat(50)), "should drop the head");
	});

	it("reports omitted character counts", () => {
		const text = "x".repeat(120);
		const out = truncateTranscript(text, 20);
		assert.ok(out.includes("120"), "should mention original length");
		assert.ok(out.includes("100"), "should mention omitted count");
	});

	it("treats non-positive limits as no cap", () => {
		const text = "abc";
		assert.equal(truncateTranscript(text, 0), text);
		assert.equal(truncateTranscript(text, -5), text);
	});
});

describe("maxTranscriptChars config", () => {
	it("has a positive explicit default", () => {
		assert.ok(Number.isInteger(DEFAULT_MAX_TRANSCRIPT_CHARS) && DEFAULT_MAX_TRANSCRIPT_CHARS > 0);
		assert.equal(fallback.maxTranscriptChars, DEFAULT_MAX_TRANSCRIPT_CHARS);
	});

	it("preserves a valid stored value", () => {
		const out = normalizeConfig({ maxTranscriptChars: 5000 }, fallback);
		assert.equal(out.maxTranscriptChars, 5000);
	});

	it("falls back on invalid values", () => {
		for (const bad of [0, -10, Number.NaN]) {
			const out = normalizeConfig({ maxTranscriptChars: bad }, fallback);
			assert.equal(out.maxTranscriptChars, fallback.maxTranscriptChars);
		}
		const out = normalizeConfig({}, fallback);
		assert.equal(out.maxTranscriptChars, fallback.maxTranscriptChars);
	});
});
