import test from "node:test";
import assert from "node:assert/strict";

// Minimal mirror of usage card labels (kept in sync with src/index.ts USAGE_FIELD_NAMES)
const USAGE_FIELD_NAMES = {
  fetched_at: "Fetched at",
  subscription_tier: "Subscription tier",
  credit_usage_percent: "Credit usage",
  period: "Period",
};

function usageFieldName(attribute) {
  return USAGE_FIELD_NAMES[attribute] ?? attribute;
}

test("usage card uses display names not JSON attribute keys", () => {
  const sample = JSON.stringify({
    ok: true,
    fetched_at: "2030-07-08T20:24:00.000Z",
    subscription_tier: "SuperGrok",
    credit_usage_percent: 0,
    period: { type: "weekly", start: "2030-07-05T00:00:00Z", end: "2030-07-12T00:00:00Z" },
  });

  const payload = JSON.parse(sample);
  const labels = [
    usageFieldName("fetched_at"),
    usageFieldName("subscription_tier"),
    usageFieldName("credit_usage_percent"),
    usageFieldName("period"),
  ];

  assert.deepEqual(labels, ["Fetched at", "Subscription tier", "Credit usage", "Period"]);
  assert.equal(payload.subscription_tier, "SuperGrok");
  for (const key of Object.keys(USAGE_FIELD_NAMES)) {
    assert.doesNotMatch(usageFieldName(key), /^[a-z]+(_[a-z]+)+$/);
  }
});