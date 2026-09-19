import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, defaultStats, formatModelSpec } from "../dist/config.js";
import {
	buildMenuRows,
	buildModelRows,
	buildProviderRows,
	CLEAR_LABEL,
	formatPrice,
	MANUAL_ENTRY_LABEL,
	rowForLabel,
} from "../dist/config-ui.js";

const MODELS = [
	{ provider: "openai-codex", id: "gpt-5.6-sol", cost: { input: 5, output: 30 } },
	{ provider: "openai-codex", id: "gpt-5.6-luna", cost: { input: 0.2, output: 1.2 } },
	{ provider: "openai-codex", id: "gpt-5.6-terra", cost: { input: 2, output: 12 } },
	{ provider: "groq", id: "openai/gpt-oss-20b", cost: { input: 0, output: 0 } },
	{ provider: "groq", id: "llama-3.1-8b-instant", cost: { input: 0.05, output: 0.08 } },
];

describe("buildMenuRows", () => {
	it("shows every setting with its current value", () => {
		const rows = buildMenuRows(defaultConfig(), defaultStats());
		const keys = rows.map((row) => row.key);
		assert.deepEqual(keys, [
			"sidekick",
			"upgrade",
			"frontier",
			"tools",
			"thinking",
			"max-delegations",
			"routing",
			"enabled",
			"restart",
			"reset",
			"close",
		]);
		assert.ok(rows[0].label.endsWith(formatModelSpec(defaultConfig().sidekick)));
		assert.match(rows[3].label, /coding \(read, grep, find, ls, edit, write, bash\)/);
		assert.match(rows[6].label, /off$/);
	});

	it("reports unset optional models rather than hiding the row", () => {
		const rows = buildMenuRows(defaultConfig(), defaultStats());
		assert.match(rows[1].label, /unset$/);
		assert.match(rows[2].label, /unset$/);
	});

	it("reflects edits back into the labels", () => {
		const config = { ...defaultConfig(), routing: true, toolMode: "readonly", enabled: false };
		const rows = buildMenuRows(config, { ...defaultStats(), delegations: 4 });
		assert.match(rows[3].label, /readonly \(read, grep, find, ls\)/);
		assert.match(rows[5].label, /4\/25 used/);
		assert.match(rows[6].label, /on$/);
		assert.match(rows[7].label, /disabled$/);
	});

	it("aligns the value column", () => {
		const rows = buildMenuRows(defaultConfig(), defaultStats()).slice(0, 8);
		const columns = rows.map((row) => {
			const match = /^(\S.*?)\s{2,}(\S.*)$/.exec(row.label);
			assert.ok(match, `unexpected label: ${row.label}`);
			return row.label.length - match[2].length;
		});
		assert.equal(new Set(columns).size, 1, `values start at columns ${[...new Set(columns)].join(", ")}`);
	});
});

describe("buildProviderRows", () => {
	it("lists providers alphabetically with model counts", () => {
		assert.deepEqual(buildProviderRows(MODELS), [
			{ key: "groq", label: "groq (2)" },
			{ key: "openai-codex", label: "openai-codex (3)" },
		]);
	});

	it("ignores entries without a usable provider", () => {
		assert.deepEqual(buildProviderRows([{ id: "x" }, { provider: "", id: "y" }]), []);
	});
});

describe("buildModelRows", () => {
	it("lists sidekick candidates cheapest first, with prices", () => {
		const rows = buildModelRows(MODELS, "openai-codex", "cheapest");
		assert.deepEqual(rows.map((row) => row.key), [
			"openai-codex/gpt-5.6-luna",
			"openai-codex/gpt-5.6-terra",
			"openai-codex/gpt-5.6-sol",
		]);
		assert.match(rows[0].label, /gpt-5\.6-luna {2}\$0\.20\/\$1\.20 per Mtok/);
	});

	it("lists frontier candidates priciest first", () => {
		const rows = buildModelRows(MODELS, "openai-codex", "priciest");
		assert.equal(rows[0].key, "openai-codex/gpt-5.6-sol");
	});

	it("keeps provider-qualified ids intact", () => {
		const rows = buildModelRows(MODELS, "groq", "cheapest");
		assert.equal(rows[0].key, "groq/openai/gpt-oss-20b");
		assert.match(rows[0].label, /free/);
	});

	it("returns nothing for a provider with no models", () => {
		assert.deepEqual(buildModelRows(MODELS, "nope", "cheapest"), []);
	});
});

describe("formatPrice", () => {
	it("marks zero-cost models free and omits unknown prices", () => {
		assert.equal(formatPrice({ cost: { input: 0, output: 0 } }), "  free");
		assert.equal(formatPrice({}), "");
		assert.equal(formatPrice({ cost: { input: "x", output: 1 } }), "");
	});

	it("shows cheap rates without dropping them to zero", () => {
		assert.equal(formatPrice({ cost: { input: 0.05, output: 0.08 } }), "  $0.05/$0.08 per Mtok");
		assert.equal(formatPrice({ cost: { input: 0.002, output: 0.004 } }), "  $0.0020/$0.0040 per Mtok");
	});
});

describe("rowForLabel", () => {
	it("maps a selected label back to its key", () => {
		const rows = buildMenuRows(defaultConfig(), defaultStats());
		assert.equal(rowForLabel(rows, rows[4].label)?.key, "thinking");
	});

	it("treats a cancelled dialog as no selection", () => {
		const rows = buildMenuRows(defaultConfig(), defaultStats());
		assert.equal(rowForLabel(rows, undefined), undefined);
		assert.equal(rowForLabel(rows, "not a row"), undefined);
	});

	it("does not collide with the extra picker entries", () => {
		const rows = buildProviderRows(MODELS);
		assert.equal(rowForLabel(rows, MANUAL_ENTRY_LABEL), undefined);
		assert.equal(rowForLabel(rows, CLEAR_LABEL), undefined);
	});
});
