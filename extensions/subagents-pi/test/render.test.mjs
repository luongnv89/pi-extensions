import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderFleetLines } from "../dist/render.js";

const theme = {
	bold: (text) => `\u001b[1m${text}\u001b[22m`,
	fg: (_color, text) => `\u001b[36m${text}\u001b[39m`,
};

function row(index = 1) {
	return {
		id: `agent-${index}`,
		type: `general-purpose-${index}`,
		description: "Investigate a deliberately long task description without hiding metrics",
		status: "running",
		model: "openai-codex/gpt-5.5",
		thinking: "high",
		context: "12.4k (62% · ⇊2)",
		tps: "42.3",
		duration: "8.2s",
		toolUses: 7,
	};
}

function render(rows, width) {
	return renderFleetLines(theme, rows, { companionReady: true, enabled: true }, width);
}

describe("renderFleetLines", () => {
	for (const width of [80, 120]) {
		it(`preserves required metrics within ${width} columns`, () => {
			const lines = render([row()], width);
			const text = stripVTControlCharacters(lines.join("\n"));

			assert.match(text, /ctx 12\.4k \(62% · ⇊2\)/);
			assert.match(text, /tps 42\.3/);
			assert.match(text, /model openai-codex\/gpt-5\.5/);
			assert.match(text, /think high/);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
		});
	}

	it("renders every managed subagent in fleets larger than fourteen", () => {
		const rows = Array.from({ length: 16 }, (_, index) => row(index + 1));
		const text = stripVTControlCharacters(render(rows, 80).join("\n"));

		for (const agent of rows) assert.match(text, new RegExp(agent.type));
		assert.doesNotMatch(text, /\+\d+ more/);
	});
});
