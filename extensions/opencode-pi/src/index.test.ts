import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Api, Context, Message, Model } from "@earendil-works/pi-ai";
import {
  discoverModels,
  imageContentsForModel,
  isToolCallMarkerResponse,
  parseToolCalls,
  parseVerboseModels,
  reasoningCliArgs,
  streamOpenCode,
} from "./index.js";

function fakeModel(): Model<Api> {
  return {
    id: "opencode/fake-free",
    name: "Fake",
    api: "opencode-cli-runner",
    provider: "opencode-cli",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

function fakeContext(): Context {
  return { messages: [] };
}

// A fake AbortSignal that reports not-aborted on its first read (mirroring the
// pre-spawn check at the top of streamOpenCode) and aborted on every read
// after that, so it deterministically simulates an abort landing in the
// async gap right after the first check without racing real timers.
function abortAfterFirstCheck(): AbortSignal {
  let calls = 0;
  return {
    get aborted() {
      calls += 1;
      return calls > 1;
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as AbortSignal;
}

// Same idea as abortAfterFirstCheck, but reports not-aborted for the first
// two reads (the pre-spawn check and the recheck after createTempAgentDir)
// and aborted from the third read onward, so it deterministically lands the
// abort in the async gap right after writeImageFiles instead.
function abortAfterSecondCheck(): AbortSignal {
  let calls = 0;
  return {
    get aborted() {
      calls += 1;
      return calls > 2;
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as AbortSignal;
}

// process.env values are coerced to strings, so `process.env.X = undefined`
// sets it to the literal string "undefined" instead of clearing it. Restore
// via delete when the original value was unset.
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function writeFakeOpencodeBinary(sentinelPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-pi-fake-bin-"));
  const binPath = join(dir, "opencode-fake.js");
  writeFileSync(
    binPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(sentinelPath)}, "ran");
process.stdout.write(JSON.stringify({ type: "text", part: { text: "ok" } }) + "\\n");
`,
    "utf8",
  );
  chmodSync(binPath, 0o755);
  return binPath;
}

function writeReasoningOnlyOpencodeBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-pi-fake-bin-"));
  const binPath = join(dir, "opencode-fake.js");
  writeFileSync(
    binPath,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "reasoning", part: { text: "thinking it through" } }) + "\\n");
`,
    "utf8",
  );
  chmodSync(binPath, 0o755);
  return binPath;
}

test("parseVerboseModels normalizes capabilities, limits, and variants", () => {
  const output = `opencode/vision-reasoner-free
{
  "id": "vision-reasoner-free",
  "name": "Vision Reasoner",
  "cost": { "input": 99, "output": 99 },
  "limit": { "context": 200000, "output": 32000 },
  "capabilities": {
    "reasoning": true,
    "input": { "text": true, "image": true }
  },
  "variants": {
    "none": { "reasoningEffort": "none" },
    "low": { "reasoningEffort": "low" },
    "high": { "reasoningEffort": "high" },
    "max": { "reasoningEffort": "max" }
  }
}
opencode/text-free
{
  "id": "text-free",
  "name": "Text {Free}",
  "limit": { "context": 64000, "output": 4096 },
  "capabilities": {
    "reasoning": false,
    "input": { "text": true, "image": false }
  },
  "variants": {}
}
`;

  assert.deepEqual(parseVerboseModels(output), [
    {
      id: "opencode/vision-reasoner-free",
      name: "Vision Reasoner",
      reasoning: true,
      image: true,
      contextWindow: 200000,
      maxTokens: 32000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: {
        off: "none",
        minimal: null,
        low: "low",
        medium: null,
        high: "high",
        xhigh: "max",
      },
    },
    {
      id: "opencode/text-free",
      name: "Text {Free}",
      reasoning: false,
      image: false,
      contextWindow: 64000,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ]);
});

test("parseVerboseModels maps an OpenCode off variant to Pi off", () => {
  const output = `opencode/reasoner-free
{
  "capabilities": { "reasoning": true },
  "variants": { "off": {}, "medium": {} }
}
`;

  assert.deepEqual(parseVerboseModels(output)[0]?.thinkingLevelMap, {
    off: "off",
    minimal: null,
    low: null,
    medium: "medium",
    high: null,
    xhigh: null,
  });
});

test("reasoningCliArgs respects off, selected levels, and provider defaults", () => {
  const map = { off: "none", low: "low" } as const;

  assert.deepEqual(reasoningCliArgs("off", map), []);
  assert.deepEqual(reasoningCliArgs("low", map), [
    "--thinking",
    "--variant",
    "low",
  ]);
  assert.deepEqual(reasoningCliArgs(undefined, map), []);
  assert.deepEqual(reasoningCliArgs("high", map), ["--thinking"]);
});

test("imageContentsForModel omits historical images for text-only models", () => {
  const historicalImage = {
    type: "image" as const,
    mimeType: "image/png",
    data: "AAAA",
  };
  const messages: Message[] = [
    {
      role: "user",
      content: [historicalImage],
      timestamp: 1,
    },
    {
      role: "user",
      content: "Continue without re-sending the old image",
      timestamp: 2,
    },
  ];

  assert.deepEqual(imageContentsForModel(messages, false), []);
  assert.deepEqual(imageContentsForModel(messages, true), [historicalImage]);
});

test("parseVerboseModels skips malformed metadata and uses safe defaults", () => {
  const output = `opencode/broken-free
{not json}
opencode/custom-free
{
  "capabilities": { "reasoning": true, "input": {} },
  "variants": {}
}
`;

  assert.deepEqual(parseVerboseModels(output), [
    {
      id: "opencode/custom-free",
      name: "OpenCode custom-free",
      reasoning: true,
      image: false,
      contextWindow: 128000,
      maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: {
        minimal: null,
        low: null,
        medium: null,
        high: null,
        xhigh: null,
      },
    },
  ]);
});

test("parseToolCalls accepts complete marker-only responses", () => {
  const response = `
<pi_tool_call>{"name":"read","arguments":{"path":"README.md"}}</pi_tool_call>
<pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}}</pi_tool_call>
`;

  assert.deepEqual(parseToolCalls(response, new Set(["read", "bash"])), [
    { name: "read", arguments: { path: "README.md" } },
    { name: "bash", arguments: { command: "pwd" } },
  ]);
});

test("parseToolCalls rejects all calls when any marker payload is malformed", () => {
  const response = `
<pi_tool_call>{"name":"read","arguments":{"path":"README.md"}}</pi_tool_call>
<pi_tool_call>{not json}</pi_tool_call>
`;

  assert.deepEqual(parseToolCalls(response, new Set(["read"])), []);
});

test("parseToolCalls rejects all calls when any candidate has invalid arguments", () => {
  const response = `<pi_tool_call>[
    {"name":"read","arguments":{"path":"README.md"}},
    {"name":"read","arguments":[]}
  ]</pi_tool_call>`;

  assert.deepEqual(parseToolCalls(response, new Set(["read"])), []);
});

test("parseToolCalls supports nested function calls and JSON-string arguments", () => {
  const response = `<pi_tool_call>{"tool_calls":[{"type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"src/index.ts\\"}"}}]}</pi_tool_call>`;

  assert.deepEqual(parseToolCalls(response, new Set(["read"])), [
    { name: "read", arguments: { path: "src/index.ts" } },
  ]);
});

test("parseToolCalls never treats plain JSON or mixed prose as control syntax", () => {
  assert.deepEqual(
    parseToolCalls('{"name":"bash","arguments":{"command":"pwd"}}'),
    [],
  );
  assert.deepEqual(
    parseToolCalls(
      'Example: <pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}}</pi_tool_call>',
    ),
    [],
  );
  assert.deepEqual(
    parseToolCalls(
      '"<pi_tool_call>{\\"name\\":\\"bash\\",\\"arguments\\":{}}</pi_tool_call>"',
    ),
    [],
  );
});

test("parseToolCalls rejects tool names absent from the current context", () => {
  const response = `<pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}}</pi_tool_call>`;
  assert.deepEqual(parseToolCalls(response, new Set(["read"])), []);
});

test("parseToolCalls ignores marker-like text embedded inside JSON string arguments", () => {
  const response = `<pi_tool_call>{"name":"bash","arguments":{"command":"echo '</pi_tool_call>'"}}</pi_tool_call>`;

  assert.deepEqual(parseToolCalls(response, new Set(["bash"])), [
    { name: "bash", arguments: { command: "echo '</pi_tool_call>'" } },
  ]);
});

test("isToolCallMarkerResponse detects a marker followed by trailing prose", () => {
  const response = `<pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}}</pi_tool_call> thanks!`;
  assert.equal(isToolCallMarkerResponse(response), true);
});

test("isToolCallMarkerResponse detects leading prose followed by a marker", () => {
  const response = `Sure, one moment: <pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}}</pi_tool_call>`;
  assert.equal(isToolCallMarkerResponse(response), true);
});

test("isToolCallMarkerResponse is false for plain text with no marker syntax", () => {
  assert.equal(isToolCallMarkerResponse("Sure, here is the answer."), false);
});

test("isToolCallMarkerResponse is false for a lone closing marker with no opening marker", () => {
  const response =
    "The bridge closes tool calls with a literal `</pi_tool_call>` tag.";
  assert.equal(isToolCallMarkerResponse(response), false);
});

test("streamOpenCode never spawns opencode when the signal aborts before the child is launched", async () => {
  const sentinelDir = mkdtempSync(join(tmpdir(), "opencode-pi-sentinel-"));
  const sentinelPath = join(sentinelDir, "ran.marker");
  const binPath = writeFakeOpencodeBinary(sentinelPath);
  const previousBin = process.env.OPENCODE_PI_BIN;
  process.env.OPENCODE_PI_BIN = binPath;

  try {
    const message = await streamOpenCode(fakeModel(), fakeContext(), {
      signal: abortAfterFirstCheck(),
    }).result();

    assert.equal(message.stopReason, "aborted");
    assert.equal(existsSync(sentinelPath), false);
  } finally {
    restoreEnv("OPENCODE_PI_BIN", previousBin);
    rmSync(sentinelDir, { recursive: true, force: true });
  }
});

test("streamOpenCode spawns opencode and returns its output when not aborted", async () => {
  const sentinelDir = mkdtempSync(join(tmpdir(), "opencode-pi-sentinel-"));
  const sentinelPath = join(sentinelDir, "ran.marker");
  const binPath = writeFakeOpencodeBinary(sentinelPath);
  const previousBin = process.env.OPENCODE_PI_BIN;
  process.env.OPENCODE_PI_BIN = binPath;

  try {
    const message = await streamOpenCode(
      fakeModel(),
      fakeContext(),
    ).result();

    assert.equal(existsSync(sentinelPath), true);
    assert.equal(message.stopReason, "stop");
  } finally {
    restoreEnv("OPENCODE_PI_BIN", previousBin);
    rmSync(sentinelDir, { recursive: true, force: true });
  }
});

test("streamOpenCode never spawns opencode when the signal aborts after image file setup", async () => {
  const sentinelDir = mkdtempSync(join(tmpdir(), "opencode-pi-sentinel-"));
  const sentinelPath = join(sentinelDir, "ran.marker");
  const binPath = writeFakeOpencodeBinary(sentinelPath);
  const previousBin = process.env.OPENCODE_PI_BIN;
  process.env.OPENCODE_PI_BIN = binPath;

  try {
    const message = await streamOpenCode(fakeModel(), fakeContext(), {
      signal: abortAfterSecondCheck(),
    }).result();

    assert.equal(message.stopReason, "aborted");
    assert.equal(existsSync(sentinelPath), false);
  } finally {
    restoreEnv("OPENCODE_PI_BIN", previousBin);
    rmSync(sentinelDir, { recursive: true, force: true });
  }
});

test("streamOpenCode succeeds when opencode emits reasoning-only output with no text or tool calls", async () => {
  const previousBin = process.env.OPENCODE_PI_BIN;
  const binPath = writeReasoningOnlyOpencodeBinary();
  process.env.OPENCODE_PI_BIN = binPath;

  try {
    const message = await streamOpenCode(fakeModel(), fakeContext()).result();

    assert.equal(message.stopReason, "stop");
    assert.equal(message.errorMessage, undefined);
    const thinkingBlock = message.content.find(
      (block) => block.type === "thinking",
    );
    assert.equal(thinkingBlock?.thinking, "thinking it through");
    assert.equal(
      message.content.some((block) => block.type === "text"),
      false,
    );
  } finally {
    restoreEnv("OPENCODE_PI_BIN", previousBin);
  }
});

test("discoverModels bypasses opencode discovery when OPENCODE_PI_MODELS is set", async () => {
  const sentinelDir = mkdtempSync(join(tmpdir(), "opencode-pi-sentinel-"));
  const sentinelPath = join(sentinelDir, "ran.marker");
  const binPath = writeFakeOpencodeBinary(sentinelPath);
  const previousBin = process.env.OPENCODE_PI_BIN;
  const previousModels = process.env.OPENCODE_PI_MODELS;
  process.env.OPENCODE_PI_BIN = binPath;
  process.env.OPENCODE_PI_MODELS = "custom-model-a, opencode/custom-model-b";

  try {
    const { models, error } = await discoverModels();

    assert.equal(existsSync(sentinelPath), false);
    assert.equal(error, undefined);
    assert.deepEqual(
      models.map((model) => model.id),
      ["opencode/custom-model-a", "opencode/custom-model-b"],
    );
  } finally {
    restoreEnv("OPENCODE_PI_BIN", previousBin);
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
    rmSync(sentinelDir, { recursive: true, force: true });
  }
});

test("discoverModels runs opencode discovery and filters to free models when OPENCODE_PI_MODELS is unset", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  const previousBin = process.env.OPENCODE_PI_BIN;
  delete process.env.OPENCODE_PI_MODELS;
  const dir = mkdtempSync(join(tmpdir(), "opencode-pi-fake-bin-"));
  const binPath = join(dir, "opencode-fake.js");
  writeFileSync(
    binPath,
    `#!/usr/bin/env node
process.stdout.write([
  "opencode/one-free",
  JSON.stringify({ capabilities: { reasoning: true, input: { image: true } } }),
  "opencode/two-paid",
  JSON.stringify({ capabilities: {} }),
].join("\\n"));
`,
    "utf8",
  );
  chmodSync(binPath, 0o755);
  process.env.OPENCODE_PI_BIN = binPath;

  try {
    const { models, error } = await discoverModels();

    assert.equal(error, undefined);
    assert.deepEqual(
      models.map((model) => model.id),
      ["opencode/one-free"],
    );
  } finally {
    restoreEnv("OPENCODE_PI_BIN", previousBin);
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverModels with forceDiscovery still enriches configured models from opencode metadata", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  const previousBin = process.env.OPENCODE_PI_BIN;
  process.env.OPENCODE_PI_MODELS = "custom-reasoner-free";
  const dir = mkdtempSync(join(tmpdir(), "opencode-pi-fake-bin-"));
  const binPath = join(dir, "opencode-fake.js");
  writeFileSync(
    binPath,
    `#!/usr/bin/env node
process.stdout.write([
  "opencode/custom-reasoner-free",
  JSON.stringify({
    capabilities: { reasoning: true, input: { image: true } },
    variants: { off: {}, high: {} },
  }),
].join("\\n"));
`,
    "utf8",
  );
  chmodSync(binPath, 0o755);
  process.env.OPENCODE_PI_BIN = binPath;

  try {
    const { models, error } = await discoverModels({ forceDiscovery: true });

    assert.equal(error, undefined);
    assert.equal(models.length, 1);
    assert.equal(models[0]?.id, "opencode/custom-reasoner-free");
    assert.equal(models[0]?.reasoning, true);
    assert.equal(models[0]?.image, true);
  } finally {
    restoreEnv("OPENCODE_PI_BIN", previousBin);
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
    rmSync(dir, { recursive: true, force: true });
  }
});
