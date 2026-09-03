import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ADVISOR_MODEL,
  LEGACY_DEFAULT_ADVISOR_MODEL,
  defaultConfig,
  modelResolves,
  normalizeConfig,
  resolveAdvisorModel,
} from "../dist/index.js";

function fakeRegistry(models, available) {
  const known = new Set(models);
  return {
    find: (provider, modelId) => (known.has(`${provider}/${modelId}`) ? { provider, id: modelId } : undefined),
    getAvailable: () => (available ?? []).map((spec) => ({ provider: spec.split("/")[0], id: spec.split("/").slice(1).join("/") })),
  };
}

function split(spec) {
  const slash = spec.indexOf("/");
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

const fallback = defaultConfig();

describe("modelResolves", () => {
  it("returns true when the registry finds the model", () => {
    const registry = fakeRegistry(["openai-codex/gpt-5.6-sol"]);
    assert.equal(modelResolves(registry, "openai-codex", "gpt-5.6-sol"), true);
  });

  it("returns false when the model is missing", () => {
    const registry = fakeRegistry([]);
    assert.equal(modelResolves(registry, "openai-codex", "gpt-5.6-sol"), false);
  });

  it("returns false when the registry throws or is absent", () => {
    assert.equal(modelResolves({ find: () => { throw new Error("boom"); } }, "a", "b"), false);
    assert.equal(modelResolves(undefined, "a", "b"), false);
  });
});

describe("resolveAdvisorModel", () => {
  it("picks the first resolving candidate", () => {
    const registry = fakeRegistry(["prov-b/m2"]);
    const picked = resolveAdvisorModel(registry, [
      { provider: "prov-a", modelId: "m1" },
      { provider: "prov-b", modelId: "m2" },
    ]);
    assert.deepEqual(picked, { provider: "prov-b", modelId: "m2" });
  });

  it("falls back to the first available model when no candidate resolves", () => {
    const registry = fakeRegistry(["other/m9"], ["other/m9"]);
    const picked = resolveAdvisorModel(registry, [{ provider: "nope", modelId: "missing" }]);
    assert.deepEqual(picked, { provider: "other", modelId: "m9" });
  });

  it("returns undefined when nothing resolves", () => {
    const registry = fakeRegistry([]);
    assert.equal(resolveAdvisorModel(registry, [{ provider: "nope", modelId: "missing" }]), undefined);
    assert.equal(resolveAdvisorModel(undefined, [{ provider: "a", modelId: "b" }]), undefined);
  });
});

describe("normalizeConfig legacy migration guard", () => {
  const legacy = split(LEGACY_DEFAULT_ADVISOR_MODEL);

  it("rewrites the legacy default onto a resolving target", () => {
    const target = split(DEFAULT_ADVISOR_MODEL);
    const registry = fakeRegistry([DEFAULT_ADVISOR_MODEL]);
    const out = normalizeConfig({ provider: legacy.provider, modelId: legacy.modelId }, fallback, registry);
    assert.equal(out.provider, target.provider);
    assert.equal(out.modelId, target.modelId);
  });

  it("keeps the stored legacy model when the migration target does not resolve", () => {
    const registry = fakeRegistry([LEGACY_DEFAULT_ADVISOR_MODEL]);
    const out = normalizeConfig({ provider: legacy.provider, modelId: legacy.modelId }, fallback, registry);
    assert.equal(out.provider, legacy.provider);
    assert.equal(out.modelId, legacy.modelId);
  });

  it("never replaces a resolving stored model with a non-resolving one", () => {
    const stored = { provider: "custom", modelId: "advisor-v1", maxUses: 3 };
    const registry = fakeRegistry(["custom/advisor-v1"]);
    const out = normalizeConfig(stored, fallback, registry);
    assert.equal(out.provider, "custom");
    assert.equal(out.modelId, "advisor-v1");
    assert.equal(out.maxUses, 3);
  });

  it("preserves the previous migration behavior without a registry", () => {
    const target = split(DEFAULT_ADVISOR_MODEL);
    const out = normalizeConfig({ provider: legacy.provider, modelId: legacy.modelId }, fallback);
    assert.equal(out.provider, target.provider);
    assert.equal(out.modelId, target.modelId);
  });
});
