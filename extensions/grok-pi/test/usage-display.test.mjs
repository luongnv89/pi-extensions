import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { formatUsageCard, productDisplayName, usageFieldName } = await import(
  `file://${join(extRoot, "src/usage.ts")}`
);

test("usage card uses display names not JSON attribute keys", () => {
  const labels = [
    usageFieldName("fetched_at"),
    usageFieldName("subscription_tier"),
    usageFieldName("credit_usage_percent"),
    usageFieldName("product_usage"),
    usageFieldName("period"),
  ];

  assert.deepEqual(labels, [
    "Fetched at",
    "Subscription tier",
    "Credit usage",
    "Allowances",
    "Period",
  ]);
  for (const key of ["fetched_at", "subscription_tier", "credit_usage_percent", "product_usage", "period"]) {
    assert.doesNotMatch(usageFieldName(key), /^[a-z]+(_[a-z]+)+$/);
  }
});

test("usage card lists the product allowance bank", () => {
  assert.equal(productDisplayName("GrokBuild"), "Grok Build");
  assert.equal(productDisplayName("GrokChat"), "Grok Chat");

  const card = formatUsageCard(
    JSON.stringify({
      ok: true,
      fetched_at: "2030-07-08T20:24:00.000Z",
      subscription_tier: "SuperGrok",
      credit_usage_percent: 87,
      product_usage: [
        { product: "GrokBuild", usage_percent: 87 },
        { product: "GrokChat" },
      ],
      period: { type: "weekly", start: "2030-07-05T00:00:00Z", end: "2030-07-12T00:00:00Z" },
    }),
  );

  assert.match(card, /Grok Build/);
  assert.match(card, /87%/);
  assert.match(card, /Grok Chat/);
  assert.match(card, /—/);
  assert.doesNotMatch(card, /Credit usage/);
  assert.doesNotMatch(card, /product_usage/);
});

test("usage card keeps overall credit when product percents differ", () => {
  const card = formatUsageCard(
    JSON.stringify({
      ok: true,
      fetched_at: "2030-07-08T20:24:00.000Z",
      subscription_tier: "SuperGrok",
      credit_usage_percent: 80,
      product_usage: [
        { product: "GrokBuild", usage_percent: 70 },
        { product: "GrokChat", usage_percent: 40 },
      ],
      period: { type: "weekly" },
    }),
  );

  assert.match(card, /Credit usage/);
  assert.match(card, /80%/);
  assert.match(card, /Grok Build/);
  assert.match(card, /70%/);
  assert.match(card, /Grok Chat/);
  assert.match(card, /40%/);
});
