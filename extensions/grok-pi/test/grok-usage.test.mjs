import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);
const helper = new URL("../bin/grok-usage", import.meta.url).pathname;

async function makeFakeHome() {
  const home = await mkdtemp(join(tmpdir(), "grok-usage-test-"));
  await mkdir(join(home, ".grok", "logs"), { recursive: true });
  await writeFile(join(home, ".grok", "auth.json"), "{}\n", { mode: 0o600 });
  return home;
}

test("grok-usage prints fresh usage JSON", async () => {
  const home = await makeFakeHome();
  const fakeGrok = join(home, "fake-grok");
  const billingEntry = {
    ts: "2030-01-02T03:04:05.000Z",
    src: "shell",
    lvl: "info",
    msg: "billing: fetched credits config",
    ctx: {
      config: {
        creditUsagePercent: 42.5,
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_MONTHLY",
          start: "2030-01-01T00:00:00+00:00",
          end: "2030-02-01T00:00:00+00:00",
        },
        onDemandCap: { val: 100 },
        onDemandUsed: { val: 12 },
        prepaidBalance: { val: 3 },
        productUsage: [
          { product: "GrokBuild", usagePercent: 42.5 },
          { product: "GrokChat" },
        ],
        historyLen: 7,
      },
      onDemandEnabled: true,
      subscriptionTier: "SuperGrok",
    },
  };

  await writeFile(
    fakeGrok,
    `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(billingEntry)}' >> "$HOME/.grok/logs/unified.jsonl"\nsleep 30\n`,
    { mode: 0o700 },
  );

  try {
    const { stdout } = await execFileAsync(helper, ["--timeout", "3"], {
      env: { ...process.env, HOME: home, GROK_PI_BIN: fakeGrok },
      timeout: 10_000,
    });
    const payload = JSON.parse(stdout);

    assert.equal(payload.ok, true);
    assert.equal(payload.source, "fresh");
    assert.equal(payload.subscription_tier, "SuperGrok");
    assert.equal(payload.credit_usage_percent, 42.5);
    assert.equal(payload.period.type, "monthly");
    assert.equal(payload.on_demand.used, 12);
    assert.equal(payload.on_demand.cap, 100);
    assert.equal(payload.prepaid_balance, 3);
    assert.deepEqual(payload.product_usage, [
      { product: "GrokBuild", usage_percent: 42.5 },
      { product: "GrokChat", usage_percent: null },
    ]);
    assert.equal(payload.refresh_error, null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("grok-usage prints JSON errors", async () => {
  const home = await mkdtemp(join(tmpdir(), "grok-usage-test-no-auth-"));
  try {
    await assert.rejects(
      execFileAsync(helper, [], { env: { ...process.env, HOME: home }, timeout: 10_000 }),
      (error) => {
        const payload = JSON.parse(error.stdout);
        assert.equal(payload.ok, false);
        assert.match(payload.error, /auth file not found/);
        return true;
      },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("grok-usage prefers the live credits API product bank", async () => {
  const home = await makeFakeHome();
  await writeFile(
    join(home, ".grok", "auth.json"),
    JSON.stringify({
      session: {
        key: "test-token",
        expires_at: "2099-01-01T00:00:00Z",
      },
    }),
    { mode: 0o600 },
  );
  await writeFile(join(home, ".grok", "version.json"), JSON.stringify({ version: "1.0.3" }));

  const seen = { auth: "" };
  const server = createServer((req, res) => {
    seen.auth = String(req.headers.authorization ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        config: {
          creditUsagePercent: 87,
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2030-01-01T00:00:00+00:00",
            end: "2030-01-08T00:00:00+00:00",
          },
          productUsage: [
            { product: "GrokBuild", usagePercent: 87 },
            { product: "GrokChat" },
          ],
          isUnifiedBillingUser: true,
          topUpMethod: "TOP_UP_METHOD_SAVED_PAYMENT_METHOD",
        },
      }),
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const { stdout } = await execFileAsync(helper, ["--timeout", "3"], {
      env: {
        ...process.env,
        HOME: home,
        GROK_BILLING_URL: `http://127.0.0.1:${port}/v1/billing?format=credits`,
      },
      timeout: 10_000,
    });
    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.source, "fresh");
    assert.equal(payload.credit_usage_percent, 87);
    assert.equal(payload.period.type, "weekly");
    assert.equal(payload.unified_billing, true);
    assert.equal(payload.top_up_method, "saved_payment_method");
    assert.deepEqual(payload.product_usage, [
      { product: "GrokBuild", usage_percent: 87 },
      { product: "GrokChat", usage_percent: null },
    ]);
    assert.equal(seen.auth, "Bearer test-token");
  } finally {
    server.close();
    await rm(home, { recursive: true, force: true });
  }
});
