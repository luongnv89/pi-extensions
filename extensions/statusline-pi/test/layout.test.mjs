import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	formatGitSection,
	formatResponsiveStatusline,
	getNarrowBranchWidth,
	truncatePlainTextToWidth,
} from "../dist/index.js";

const theme = {
	fg: (_color, text) => text,
};

function assertWidthSafe(lines, width) {
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= width, `${line} exceeds ${width} columns`);
	}
}

describe("responsive statusline layout", () => {
	it("keeps the compact single-line layout when it fits", () => {
		const separator = " │ ";
		const segments = {
			dir: "pi-extensions",
			git: "main [2] PR #12",
			compactGit: "main [2] PR #12",
			context: "840,037 (84.0%) Plan",
			speed: "42.5 tok/s",
			cost: "$0.12",
			model: "openai/gpt-5.5 [T]",
		};

		const wideLine = [segments.dir, segments.git, segments.cost, segments.context, segments.speed, segments.model].join(separator);
		const lines = formatResponsiveStatusline(segments, separator, visibleWidth(wideLine));

		assert.deepEqual(lines, [wideLine]);
	});

	it("wraps into width-safe lines when a long branch would hide other segments", () => {
		const width = 70;
		const separator = " │ ";
		const branch = "issue/77-pr-number-statusline-with-a-very-very-long-branch-name";
		const compactGit = formatGitSection(theme, branch, 3, 79, getNarrowBranchWidth(width));
		const lines = formatResponsiveStatusline(
			{
				dir: "context-stats",
				git: formatGitSection(theme, branch, 3, 79),
				compactGit,
				context: "58,261 (45.5%) Code",
				speed: "87.5 tok/s",
				cost: "$0.04",
				model: "advisor:3",
			},
			separator,
			width,
		);

		assert.ok(lines.length >= 2);
		assertWidthSafe(lines, width);
		assert.ok(lines.some((line) => line.includes("58,261")), "context segment should remain visible");
		assert.ok(lines.some((line) => line.includes("87.5 tok/s")), "speed segment should remain visible");
		assert.ok(lines.some((line) => line.includes("advisor:3")), "model segment should remain visible");
		assert.ok(lines.some((line) => line.includes("[3]") && line.includes("PR #79")), "git metadata should remain visible");
	});

	it("truncates plain long branch names without ANSI reset artifacts", () => {
		const truncated = truncatePlainTextToWidth("feature/super-long-responsive-statusline-branch", 16);

		assert.equal(visibleWidth(truncated), 16);
		assert.equal(truncated, "feature/super-l…");
		assert.equal(/\u001b\[[0-9;]*m/.test(truncated), false);
	});

	it("keeps every segment width-safe at very narrow widths", () => {
		const width = 12;
		const lines = formatResponsiveStatusline(
			{
				dir: "pi-extensions",
				git: "issue/very-long-branch [3] PR #79",
				compactGit: "issue/ve… [3] PR #79",
				context: "58,261 (45.5%) Code",
				speed: "87.5 tok/s",
				cost: "",
				model: "openai/gpt-5.5 [T]",
			},
			" │ ",
			width,
		);

		assert.ok(lines.length > 2);
		assertWidthSafe(lines, width);
	});
});
