import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ADVISOR_MODEL,
  DEFAULT_MAX_TRANSCRIPT_CHARS,
  LEGACY_DEFAULT_ADVISOR_MODEL,
  STATE_ENTRY,
  defaultConfig,
  makeStateEntry,
  normalizeConfig,
  parseModelSpec,
  persistState,
} from "../dist/index.js";

const fallback = defaultConfig();

function fakeRegistry(models) {
  const known = new Set(models);
  return {
    find: (provider, modelId) => (known.has(`${provider}/${modelId}`) ? { provider, id: modelId } : undefined),
  };
}

describe("parseModelSpec", () => {
  it("splits provider and model on the first slash", () => {
    assert.deepEqual(parseModelSpec("openai-codex/gpt-5.6-sol"), {
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
    });
  });

  it("keeps extra slashes in the model id", () => {
    assert.deepEqual(parseModelSpec("prov/a/b"), { provider: "prov", modelId: "a/b" });
  });

  it("rejects specs without a usable provider and model", () => {
    assert.equal(parseModelSpec("noslash"), undefined);
    assert.equal(parseModelSpec("/model-only"), undefined);
    assert.equal(parseModelSpec("provider-only/"), undefined);
    assert.equal(parseModelSpec(""), undefined);
  });
});

describe("defaultConfig", () => {
  it("matches the documented defaults", () => {
    const slash = DEFAULT_ADVISOR_MODEL.indexOf("/");
    assert.equal(fallback.provider, DEFAULT_ADVISOR_MODEL.slice(0, slash));
    assert.equal(fallback.modelId, DEFAULT_ADVISOR_MODEL.slice(slash + 1));
    assert.equal(fallback.enabled, true);
    assert.equal(fallback.thinkingLevel, "high");
    assert.equal(fallback.maxUses, 5);
    assert.equal(fallback.cacheRetention, "short");
    assert.equal(fallback.maxTokens, 4000);
    assert.equal(fallback.timeoutMs, 600_000);
    assert.equal(fallback.maxTranscriptChars, DEFAULT_MAX_TRANSCRIPT_CHARS);
  });
});

describe("normalizeConfig field parsing", () => {
  it("preserves an explicit enabled flag and falls back on non-booleans", () => {
    assert.equal(normalizeConfig({ enabled: false }, fallback).enabled, false);
    assert.equal(normalizeConfig({ enabled: "yes" }, fallback).enabled, true);
  });

  it("preserves valid thinking levels and falls back on invalid ones", () => {
    for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
      assert.equal(normalizeConfig({ thinkingLevel: level }, fallback).thinkingLevel, level);
    }
    assert.equal(normalizeConfig({ thinkingLevel: "ultra" }, fallback).thinkingLevel, fallback.thinkingLevel);
    assert.equal(normalizeConfig({}, fallback).thinkingLevel, fallback.thinkingLevel);
  });

  it("preserves valid cache retention and falls back on invalid values", () => {
    for (const retention of ["none", "short", "long"]) {
      assert.equal(normalizeConfig({ cacheRetention: retention }, fallback).cacheRetention, retention);
    }
    assert.equal(normalizeConfig({ cacheRetention: "forever" }, fallback).cacheRetention, fallback.cacheRetention);
  });

  it("floors fractional numbers and falls back on non-positive ones", () => {
    assert.equal(normalizeConfig({ maxUses: 3.9 }, fallback).maxUses, 3);
    assert.equal(normalizeConfig({ maxTokens: 1500.7 }, fallback).maxTokens, 1500);
    assert.equal(normalizeConfig({ timeoutMs: 99.9 }, fallback).timeoutMs, 99);
    for (const bad of [0, -2, Number.NaN]) {
      assert.equal(normalizeConfig({ maxUses: bad }, fallback).maxUses, fallback.maxUses);
      assert.equal(normalizeConfig({ maxTokens: bad }, fallback).maxTokens, fallback.maxTokens);
      assert.equal(normalizeConfig({ timeoutMs: bad }, fallback).timeoutMs, fallback.timeoutMs);
    }
  });

  it("falls back on empty provider or model ids", () => {
    assert.equal(normalizeConfig({ provider: "" }, fallback).provider, fallback.provider);
    assert.equal(normalizeConfig({ modelId: "" }, fallback).modelId, fallback.modelId);
  });

  it("keeps a resolving stored model when the normalized target does not resolve", () => {
    const registry = fakeRegistry(["custom/advisor-v1"]);
    const out = normalizeConfig(
      { provider: "custom", modelId: "advisor-v1", thinkingLevel: "bogus" },
      fallback,
      registry,
    );
    assert.equal(out.provider, "custom");
    assert.equal(out.modelId, "advisor-v1");
    assert.equal(out.thinkingLevel, fallback.thinkingLevel);
  });
});

describe("legacy migration", () => {
  it("leaves non-legacy stored models untouched", () => {
    const out = normalizeConfig({ provider: "custom", modelId: "advisor-v1" }, fallback);
    assert.equal(out.provider, "custom");
    assert.equal(out.modelId, "advisor-v1");
  });

  it("does not migrate the legacy default once a thinking level was explicitly stored", () => {
    const slash = LEGACY_DEFAULT_ADVISOR_MODEL.indexOf("/");
    const out = normalizeConfig(
      {
        provider: LEGACY_DEFAULT_ADVISOR_MODEL.slice(0, slash),
        modelId: LEGACY_DEFAULT_ADVISOR_MODEL.slice(slash + 1),
        thinkingLevel: "low",
      },
      fallback,
    );
    assert.equal(out.provider, LEGACY_DEFAULT_ADVISOR_MODEL.slice(0, slash));
    assert.equal(out.thinkingLevel, "low");
  });
});

describe("state persistence", () => {
  it("exposes the session branch entry key", () => {
    assert.equal(STATE_ENTRY, "advisor-pi-state");
  });

  it("builds a versioned entry that snapshots the config", () => {
    const config = { ...fallback };
    const entry = makeStateEntry(config, 2);
    assert.equal(entry.version, 1);
    assert.equal(entry.useCount, 2);
    assert.deepEqual(entry.config, config);
    assert.ok(!Number.isNaN(Date.parse(entry.updatedAt)), "updatedAt should be an ISO timestamp");
    config.maxUses = 999;
    assert.notEqual(entry.config.maxUses, 999);
  });

  it("persists via appendEntry under the state key", () => {
    const calls = [];
    const pi = { appendEntry: (key, entry) => calls.push([key, entry]) };
    persistState(pi, fallback, 4);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], STATE_ENTRY);
    assert.equal(calls[0][1].version, 1);
    assert.equal(calls[0][1].useCount, 4);
    assert.deepEqual(calls[0][1].config, fallback);
  });
});
