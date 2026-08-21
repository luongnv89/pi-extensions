import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CACHE_TTL_MS,
  computeCacheStatus,
  formatClock,
  formatCountdown,
  formatRelative,
  formatTimestampLine,
  hasDuplicateTimestampEntry,
} from "../dist/index.js";

describe("formatClock", () => {
  it("formats as zero-padded 24h HH:MM:SS", () => {
    const ts = new Date(2026, 0, 15, 9, 5, 3).getTime();
    assert.equal(formatClock(ts), "09:05:03");
  });
});

describe("formatRelative", () => {
  const now = Date.now();

  it("shows now under 5s", () => {
    assert.equal(formatRelative(now - 4_000, now), "now");
  });

  it("shows seconds under a minute", () => {
    assert.equal(formatRelative(now - 42_000, now), "42s ago");
  });

  it("shows minutes under an hour", () => {
    assert.equal(formatRelative(now - 120_000, now), "2m ago");
  });

  it("shows hours beyond that", () => {
    assert.equal(formatRelative(now - 7_200_000, now), "2h ago");
  });

  it("clamps future timestamps to now", () => {
    assert.equal(formatRelative(now + 60_000, now), "now");
  });
});

describe("formatCountdown", () => {
  it("formats m:ss with padding", () => {
    assert.equal(formatCountdown(4 * 60_000 + 32_000), "4:32");
    assert.equal(formatCountdown(5_000), "0:05");
  });

  it("rounds up partial seconds and clamps at 0:00", () => {
    assert.equal(formatCountdown(500), "0:01");
    assert.equal(formatCountdown(-10_000), "0:00");
  });
});

describe("formatTimestampLine", () => {
  it("combines clock and relative time", () => {
    const ts = new Date(2026, 0, 15, 14, 32, 5).getTime();
    assert.equal(formatTimestampLine({ role: "user", timestamp: ts }, ts + 130_000), "⏱ 14:32:05 (2m ago)");
  });
});

describe("computeCacheStatus", () => {
  const now = Date.now();

  it("is idle without cache activity", () => {
    assert.deepEqual(computeCacheStatus(undefined, now), {
      state: "idle",
      label: "",
      remainingMs: 0,
    });
  });

  it("counts down while the cache is warm", () => {
    const status = computeCacheStatus(now - 28_000, now);
    assert.equal(status.state, "active");
    assert.equal(status.label, "cache 4:32");
    assert.equal(status.remainingMs, CACHE_TTL_MS - 28_000);
  });

  it("reports expired once the TTL elapses", () => {
    const status = computeCacheStatus(now - CACHE_TTL_MS - 1_000, now);
    assert.equal(status.state, "expired");
    assert.equal(status.label, "cache expired");
    assert.equal(status.remainingMs, 0);
  });

  it("honors a custom TTL", () => {
    const status = computeCacheStatus(now - 90_000, now, 2 * 60_000);
    assert.equal(status.state, "active");
    assert.equal(status.label, "cache 0:30");
  });
});

describe("hasDuplicateTimestampEntry", () => {
  const entry = (role, timestamp) => ({
    type: "custom",
    customType: "timestamp-pi",
    data: { role, timestamp },
  });
  const other = (customType) => ({ type: "custom", customType, data: {} });

  it("detects a duplicate within the window", () => {
    const entries = [entry("user", 1_000_000_000)];
    assert.equal(hasDuplicateTimestampEntry(entries, "user", 1_000_000_500), true);
  });

  it("ignores entries outside the window", () => {
    const entries = [entry("user", 1_000_000_000)];
    assert.equal(hasDuplicateTimestampEntry(entries, "user", 1_000_010_000), false);
  });

  it("ignores different roles", () => {
    const entries = [entry("user", 1_000_000_000)];
    assert.equal(hasDuplicateTimestampEntry(entries, "assistant", 1_000_000_100), false);
  });

  it("ignores non-timestamp entries", () => {
    const entries = [other("something-else")];
    assert.equal(hasDuplicateTimestampEntry(entries, "user", 1_000_000_000), false);
  });

  it("handles malformed or missing data", () => {
    assert.equal(hasDuplicateTimestampEntry([{ type: "custom", customType: "timestamp-pi" }], "user", 1), false);
    assert.equal(hasDuplicateTimestampEntry([], "user", 1), false);
  });

  it("scans only the recent tail", () => {
    const old = Array.from({ length: 15 }, (_, i) => entry("user", i * 10_000));
    assert.equal(hasDuplicateTimestampEntry(old, "user", 0), false);
  });
});
