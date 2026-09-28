import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../dist/index.js";
import { buildMenuRows, rowForLabel } from "../dist/config-ui.js";

const SECRET_PROVIDER = "customer@example.com";
const SECRET_MODEL = "sk_live_pi-advisor-private-key";

describe("advisor-pi settings menu rows", () => {
  it("shows each setting, a generic model value, the reset action, and Close", () => {
    const rows = buildMenuRows({
      ...defaultConfig(),
      provider: SECRET_PROVIDER,
      modelId: SECRET_MODEL,
    }, 3);
    assert.deepEqual(rows.map((row) => row.key), [
      "enabled",
      "model",
      "thinking",
      "max-uses",
      "max-transcript-chars",
      "cache",
      "reset",
      "close",
    ]);
    assert.match(rows[0].label, /enabled$/);
    assert.match(rows[1].label, /configured \(use \/advisor-pi status for ID\)$/);
    assert.ok(rows.every((row) => !row.label.includes(SECRET_PROVIDER)));
    assert.ok(rows.every((row) => !row.label.includes(SECRET_MODEL)));
    assert.match(rows[2].label, /high$/);
    assert.match(rows[3].label, /5$/);
    assert.match(rows[4].label, /20000$/);
    assert.match(rows[5].label, /short$/);
    assert.match(rows[6].label, /Reset use count\s+\(3 used\)$/);
  });

  it("maps selected labels and cancellation without exposing model values", () => {
    const rows = buildMenuRows(defaultConfig());
    assert.equal(rowForLabel(rows, undefined), undefined);
    assert.equal(rowForLabel(rows, "not a row"), undefined);
    assert.equal(rowForLabel(rows, rows[1].label)?.key, "model");
  });
});
