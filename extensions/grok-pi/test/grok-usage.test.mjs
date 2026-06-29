import { execFile } from "node:child_process";
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
