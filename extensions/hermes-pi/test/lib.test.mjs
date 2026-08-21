import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const {
  BUNDLED_MODELS,
  cleanHermesOutput,
  configuredModels,
  discoverCachedFreeModels,
  estimateTokens,
  hermesBin,
  hermesProvider,
  resolveModelInfos,
} = await import(`file://${join(extRoot, "src/lib.ts")}`);

const RAW_OUTPUT = [
  "Query: Reply with exactly OK",
  "Initializing agent...\r",
  "──────────────────────────────\r",
  "",
  "┌─ Reasoning ──────────────┐",
  "The user wants me to reply with exactly \"OK\".",
  "└──────────────────────────┘",
  "",
  "╭─ ⚕ Hermes ───────────────╮",
  "OK",
  "╰──────────────────────────╯",
  "",
  "Resume this session with:",
  "  hermes --resume 20260821_120950_4bd241",
  '  hermes -c "Reply with exactly OK"',
  "",
  "Session:        20260821_120950_4bd241",
  "Title:          Reply with exactly OK",
  "Duration:       6s",
  "Messages:       2 (1 user, 0 tool calls)",
].join("\r\n");

test("cleanHermesOutput extracts answer box and drops reasoning", () => {
  assert.equal(cleanHermesOutput(RAW_OUTPUT), "OK");
});

test("cleanHermesOutput strips decorations when no answer box", () => {
  const partial = [
    "Query: hi",
    "Initializing agent...",
    "──────",
    "┌─ Reasoning ─┐",
    "thinking...",
    "└─────────────┘",
    "",
  ].join("\n");
  const cleaned = cleanHermesOutput(partial);
  assert.ok(!cleaned.includes("Query"));
  assert.ok(!cleaned.includes("thinking"));
  assert.ok(!cleaned.includes("─"));
});

test("cleanHermesOutput keeps multi-line answers", () => {
  const raw = [
    "╭─ ⚕ Hermes ─╮",
    "line one",
    "",
    "line two",
    "╰────────────╯",
  ].join("\n");
  assert.equal(cleanHermesOutput(raw), "line one\n\nline two");
});

test("configuredModels splits on commas and whitespace", () => {
  process.env.HERMES_PI_MODELS = "a/b:free, c/d:free  e/f:free";
  assert.deepEqual(configuredModels(), ["a/b:free", "c/d:free", "e/f:free"]);
  process.env.HERMES_PI_MODELS = "   ";
  assert.equal(configuredModels(), undefined);
  delete process.env.HERMES_PI_MODELS;
});

test("hermesBin and hermesProvider honor env overrides", () => {
  assert.equal(hermesBin(), "hermes");
  assert.equal(hermesProvider(), "nous");
  process.env.HERMES_PI_BIN = " /custom/hermes ";
  process.env.HERMES_PI_PROVIDER = " xai-oauth ";
  assert.equal(hermesBin(), "/custom/hermes");
  assert.equal(hermesProvider(), "xai-oauth");
  delete process.env.HERMES_PI_BIN;
  delete process.env.HERMES_PI_PROVIDER;
});

test("resolveModelInfos reuses bundled metadata and falls back", () => {
  const [bundled] = resolveModelInfos([BUNDLED_MODELS[0].id]);
  assert.equal(bundled.name, BUNDLED_MODELS[0].name);
  const [fallback] = resolveModelInfos(["unknown/model:free"]);
  assert.equal(fallback.id, "unknown/model:free");
  assert.equal(fallback.contextWindow, 131_072);
});

test("discoverCachedFreeModels filters nous :free models", async () => {
  const cache = JSON.stringify({
    nous: { models: ["tencent/hy3:free", "anthropic/claude-opus-4", 42, null] },
    xai: { models: ["grok-4"] },
  });
  const ids = await discoverCachedFreeModels(
    "/home/test",
    async () => cache,
  );
  assert.deepEqual(ids, ["tencent/hy3:free"]);
});

test("discoverCachedFreeModels rejects on malformed cache", async () => {
  assert.deepEqual(
    await discoverCachedFreeModels("/home/test", async () => "{}"),
    [],
  );
  await assert.rejects(
    discoverCachedFreeModels("/home/test", async () => "{bad json"),
  );
});

test("estimateTokens is at least 1", () => {
  assert.equal(estimateTokens(""), 1);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("a".repeat(9)), 3);
});
