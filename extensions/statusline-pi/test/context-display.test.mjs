import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatContextSection } from "../dist/index.js";

const originalContextDisplay = process.env.STATUSLINE_PI_CONTEXT;
const theme = { fg: (_color, text) => text };
const usage = {
	contextWindow: 1_000,
	usedTokens: 250,
	usedRatio: 0.25,
	remainingTokens: 750,
	remainingPercent: 75,
};

afterEach(() => {
	if (originalContextDisplay === undefined) delete process.env.STATUSLINE_PI_CONTEXT;
	else process.env.STATUSLINE_PI_CONTEXT = originalContextDisplay;
});

describe("context display", () => {
	it("keeps the upstream remaining-context reading by default", () => {
		delete process.env.STATUSLINE_PI_CONTEXT;

		assert.equal(formatContextSection(theme, usage, "Plan"), "😄 750 (75.0%) Plan");
	});

	it("reports consumed context when STATUSLINE_PI_CONTEXT=used", () => {
		process.env.STATUSLINE_PI_CONTEXT = "used";

		assert.equal(formatContextSection(theme, usage, "Plan"), "😄 250 (25.0%) Plan");
	});
});
