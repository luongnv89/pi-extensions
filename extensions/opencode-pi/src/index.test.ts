import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  clearApiProviders,
  getApiProvider,
} from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessageEvent,
  Context,
  Message,
  Model,
} from "@earendil-works/pi-ai";
import opencodePiExtension, {
  discoverModels,
  imageContentsForModel,
  isToolCallMarkerResponse,
  parseToolCallResponse,
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

function fakeContext(toolNames: string[] = []): Context {
  return {
    messages: [],
    tools: toolNames.map((name) => ({
      name,
      description: `${name} tool`,
      parameters: {},
    })) as Context["tools"],
  };
}

function fakeEventScript(events: unknown[]): string {
  return `for (const event of ${JSON.stringify(events)}) process.stdout.write(JSON.stringify(event) + "\\n");`;
}

async function collectStreamEvents(
  script: string,
  context: Context,
): Promise<AssistantMessageEvent[]> {
  return withFakeOpenCode(script, async () => {
    const events: AssistantMessageEvent[] = [];
    for await (const event of streamOpenCode(fakeModel(), context)) {
      events.push(event);
    }
    return events;
  });
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

async function withFakeOpenCode<T>(
  script: string,
  run: () => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "opencode-pi-fake-bin-"));
  const binPath = join(dir, "opencode-fake.js");
  writeFileSync(binPath, `#!/usr/bin/env node\n${script}`, "utf8");
  chmodSync(binPath, 0o755);

  const previousBin = process.env.OPENCODE_PI_BIN;
  process.env.OPENCODE_PI_BIN = binPath;
  try {
    return await run();
  } finally {
    restoreEnv("OPENCODE_PI_BIN", previousBin);
    rmSync(dir, { recursive: true, force: true });
  }
}

function imageContext(mimeType: string, data: string): Context {
  return {
    messages: [
      {
        role: "user",
        content: [{ type: "image", mimeType, data }],
        timestamp: 1,
      },
    ],
  };
}

async function invalidImageResult(
  mimeType: string,
  data: string,
): Promise<{ message: Awaited<ReturnType<ReturnType<typeof streamOpenCode>["result"]>>; spawned: boolean }> {
  const sentinelDir = mkdtempSync(join(tmpdir(), "opencode-pi-sentinel-"));
  const sentinelPath = join(sentinelDir, "ran.marker");
  try {
    const message = await withFakeOpenCode(
      `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(sentinelPath)}, "ran");
process.stdout.write(JSON.stringify({ type: "text", part: { text: "ok" } }) + "\\n");
`,
      () =>
        streamOpenCode(
          { ...fakeModel(), input: ["text", "image"] },
          imageContext(mimeType, data),
        ).result(),
    );
    return { message, spawned: existsSync(sentinelPath) };
  } finally {
    rmSync(sentinelDir, { recursive: true, force: true });
  }
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

test("parseToolCallResponse rejects all calls when any marker payload is malformed", () => {
  const response = `
<pi_tool_call>{"name":"read","arguments":{"path":"README.md"}}</pi_tool_call>
<pi_tool_call>{not json}</pi_tool_call>
`;

  assert.deepEqual(parseToolCallResponse(response, new Set(["read"])), {
    ok: false,
    rejection: { reason: "invalid_payload" },
  });
});

test("parseToolCallResponse rejects all calls when any candidate has invalid arguments", () => {
  const response = `<pi_tool_call>[
    {"name":"read","arguments":{"path":"README.md"}},
    {"name":"read","arguments":[]}
  ]</pi_tool_call>`;

  assert.deepEqual(parseToolCallResponse(response, new Set(["read"])), {
    ok: false,
    rejection: { reason: "invalid_payload" },
  });
});

test("parseToolCalls supports nested function calls and JSON-string arguments", () => {
  const response = `<pi_tool_call>{"tool_calls":[{"type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"src/index.ts\\"}"}}]}</pi_tool_call>`;

  assert.deepEqual(parseToolCalls(response, new Set(["read"])), [
    { name: "read", arguments: { path: "src/index.ts" } },
  ]);
});

test("parseToolCalls repairs unescaped quotes emitted inside argument strings", () => {
  const response = `<pi_tool_call>{"name":"bash","arguments":{"command":"git status && echo "---" && printf "%s" done"}}</pi_tool_call>`;

  assert.deepEqual(parseToolCalls(response, new Set(["bash"])), [
    {
      name: "bash",
      arguments: {
        command: 'git status && echo "---" && printf "%s" done',
      },
    },
  ]);
});

test("parseToolCallResponse distinguishes plain text from malformed marker attempts", () => {
  // Plain text without markers returns empty calls (ok=true)
  assert.deepEqual(
    parseToolCallResponse('{"name":"bash","arguments":{"command":"pwd"}}'),
    { ok: true, calls: [] },
  );
  // Lenient parser: prose before/after valid markers is extracted
  assert.deepEqual(
    parseToolCallResponse(
      'Example: <pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}}</pi_tool_call>',
    ),
    { ok: true, calls: [{ name: "bash", arguments: { command: "pwd" } }] },
  );
  // Some models JSON-encode their entire text response.
  assert.deepEqual(
    parseToolCallResponse(
      '"<pi_tool_call>{\\"name\\":\\"bash\\",\\"arguments\\":{}}</pi_tool_call>"',
    ),
    { ok: true, calls: [{ name: "bash", arguments: {} }] },
  );
});

test("parseToolCallResponse accepts bounded closing-tag variants", () => {
  const closers = [
    "</ pi_tool_call>",
    "</pi-tool-call>",
    "</pi_tool_calls>",
    "</pi_tool_call >",
    "</PI_TOOL_CALL>",
  ];

  for (const closer of closers) {
    assert.deepEqual(
      parseToolCallResponse(
        `<pi_tool_call>{"name":"bash","arguments":{}}${closer}`,
        new Set(["bash"]),
      ),
      { ok: true, calls: [{ name: "bash", arguments: {} }] },
    );
  }
});

test("parseToolCallResponse recovers a complete JSON payload without a closing tag", () => {
  assert.deepEqual(
    parseToolCallResponse(
      '<pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}}',
      new Set(["bash"]),
    ),
    {
      ok: true,
      calls: [{ name: "bash", arguments: { command: "pwd" } }],
    },
  );
});

test("parseToolCallResponse rejects ambiguous unclosed markers", () => {
  const responses = [
    '<pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}',
    '<pi_tool_call>{"name":"bash","arguments":{}} trailing prose',
    '<pi_tool_call>{"name":"bash","arguments":{}}</tool_call>',
    '<pi_tool_call>{"name":"bash","arguments":{}}<pi_tool_call>',
  ];

  for (const response of responses) {
    assert.deepEqual(parseToolCallResponse(response, new Set(["bash"])), {
      ok: false,
      rejection: { reason: "malformed_markers" },
    });
  }
});

test("parseToolCallResponse rejects tool names absent from the current context", () => {
  const response = `<pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}}</pi_tool_call>`;
  assert.deepEqual(parseToolCallResponse(response, new Set(["read"])), {
    ok: false,
    rejection: { reason: "unavailable_tool", toolName: "bash" },
  });
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

test("streamOpenCode emits Pi tool-call events and a toolUse result", async () => {
  const marker =
    '<pi_tool_call>{"name":"read","arguments":{"path":"README.md"}}</pi_tool_call>';
  const events = await collectStreamEvents(
    fakeEventScript([{ type: "text", part: { text: marker } }]),
    fakeContext(["read"]),
  );

  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"],
  );
  const started = events.find((event) => event.type === "toolcall_start");
  const startedCall = started?.partial.content[started.contentIndex];
  assert.equal(startedCall?.type, "toolCall");

  const delta = events.find((event) => event.type === "toolcall_delta");
  assert.equal(delta?.contentIndex, started?.contentIndex);
  assert.match(delta?.delta ?? "", /"path": "README\.md"/);

  const completed = events.find((event) => event.type === "toolcall_end");
  assert.equal(completed?.contentIndex, started?.contentIndex);
  assert.equal(completed?.toolCall.name, "read");
  assert.deepEqual(completed?.toolCall.arguments, { path: "README.md" });
  assert.match(completed?.toolCall.id ?? "", /^opencode_pi_/);
  if (startedCall?.type === "toolCall") {
    assert.equal(startedCall.id, completed?.toolCall.id);
    assert.equal(startedCall.name, completed?.toolCall.name);
  }

  const done = events.at(-1);
  assert.equal(done?.type, "done");
  if (done?.type !== "done") return;
  assert.equal(done.reason, "toolUse");
  assert.equal(done.message.stopReason, "toolUse");
  assert.deepEqual(done.message.content, [completed?.toolCall]);
});

test("streamOpenCode accepts repaired tool JSON alongside thinking output", async () => {
  const marker = `<pi_tool_call>{"name":"bash","arguments":{"command":"git status && echo "---" && git log -1"}}</pi_tool_call>`;
  const events = await collectStreamEvents(
    fakeEventScript([
      { type: "reasoning", part: { text: "I should inspect the repository." } },
      { type: "text", part: { text: marker } },
    ]),
    fakeContext(["bash"]),
  );

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ],
  );
  const completed = events.find((event) => event.type === "toolcall_end");
  assert.deepEqual(completed?.toolCall.arguments, {
    command: 'git status && echo "---" && git log -1',
  });
});

test("streamOpenCode diagnoses invalid markers before emitting any tool call", async () => {
  // With the lenient parser, prose around valid markers is extracted.
  // Only truly invalid payloads (bad JSON, missing fields) produce errors.
  const cases = [
    {
      // Valid JSON but missing "arguments" field
      text: '<pi_tool_call>{"name":"read"}</pi_tool_call>',
      diagnostic:
        'OpenCode returned an invalid Pi tool-call payload. Each marker must contain valid JSON with a non-empty string "name" and object "arguments".',
    },
    {
      // Valid JSON but "arguments" is not an object
      text: '<pi_tool_call>{"name":"read","arguments":"not-an-object"}</pi_tool_call>',
      diagnostic:
        'OpenCode returned an invalid Pi tool-call payload. Each marker must contain valid JSON with a non-empty string "name" and object "arguments".',
    },
  ];

  for (const { text, diagnostic } of cases) {
    const events = await collectStreamEvents(
      fakeEventScript([{ type: "text", part: { text } }]),
      fakeContext(["read"]),
    );

    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "error"],
    );
    const error = events.at(-1);
    assert.equal(error?.type, "error");
    if (error?.type !== "error") continue;
    assert.equal(error.error.errorMessage, diagnostic);
  }
});

test("streamOpenCode diagnoses tools unavailable in the current Pi turn", async () => {
  const marker =
    '<pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}}</pi_tool_call>';
  const events = await collectStreamEvents(
    fakeEventScript([{ type: "text", part: { text: marker } }]),
    fakeContext(["read"]),
  );

  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "error"],
  );
  const error = events.at(-1);
  assert.equal(error?.type, "error");
  if (error?.type !== "error") return;
  assert.equal(
    error.error.errorMessage,
    'OpenCode requested unavailable Pi tool "bash". Use only tools available in the current Pi turn: "read".',
  );
});

test("streamOpenCode diagnoses XML-style tool-use as disabled native tool", async () => {
  const xmlResponse = `<tool_call>bash<arg_key>command</arg_key><arg_value>pwd</arg_value>`;
  const events = await collectStreamEvents(
    fakeEventScript([{ type: "text", part: { text: xmlResponse } }]),
    fakeContext(["read"]),
  );
  assert.deepEqual(events.map((e) => e.type), ["start", "error"]);
  const error = events.at(-1);
  assert.equal(error?.type, "error");
  if (error?.type !== "error") return;
  assert.ok(
    error.error?.errorMessage?.includes("disabled native tool"),
    "should diagnose XML-style tool-use as disabled native tool",
  );
  assert.ok(
    error.error?.errorMessage?.includes("<pi_tool_call>"),
    "should mention <pi_tool_call> markers in the diagnostic",
  );
});

test("streamOpenCode rejects native OpenCode tool use with marker remediation", async () => {
  const message = await withFakeOpenCode(
    fakeEventScript([{ type: "tool_use", part: { tool: "bash" } }]),
    () => streamOpenCode(fakeModel(), fakeContext(["read"])).result(),
  );

  assert.equal(message.stopReason, "error");
  assert.equal(
    message.errorMessage,
    'OpenCode attempted to use its disabled native tool ("bash"). Retry the request; Pi tools must be requested with <pi_tool_call>{"name":"...","arguments":{}}</pi_tool_call> markers.',
  );
});

test("streamOpenCode diagnoses empty provider output with detailed context", async () => {
  const message = await withFakeOpenCode("", () =>
    streamOpenCode(fakeModel(), fakeContext()).result(),
  );

  assert.equal(message.stopReason, "error");
  assert.ok(
    message.errorMessage?.includes("empty assistant response"),
    "should mention empty assistant response",
  );
  assert.ok(
    message.errorMessage?.includes("no text events received"),
    "should include raw text context",
  );
  assert.ok(
    message.errorMessage?.includes("Retry the request or select another OpenCode model"),
    "should suggest retry",
  );
});

test("streamOpenCode diagnoses empty output with whitespace-only text events", async () => {
  const message = await collectStreamEvents(
    fakeEventScript([
      { type: "text", part: { text: "   \n\n   " } },
    ]),
    fakeContext(["read"]),
  );

  const error = message.find((e) => e.type === "error");
  assert.ok(error, "should emit an error event");
  assert.equal(error?.type, "error");
  if (error?.type !== "error") return;

  assert.ok(
    error.error?.errorMessage?.includes("empty assistant response"),
    "should diagnose whitespace-only text as empty response",
  );
  assert.ok(
    error.error?.errorMessage?.includes("raw text length="),
    "should include raw text length in diagnostic",
  );
});

test("streamOpenCode never spawns opencode when the signal aborts before the child is launched", async () => {
  const sentinelDir = mkdtempSync(join(tmpdir(), "opencode-pi-sentinel-"));
  const sentinelPath = join(sentinelDir, "ran.marker");

  try {
    const message = await withFakeOpenCode(
      `require("node:fs").writeFileSync(${JSON.stringify(sentinelPath)}, "ran");`,
      () =>
        streamOpenCode(fakeModel(), fakeContext(), {
          signal: abortAfterFirstCheck(),
        }).result(),
    );

    assert.equal(message.stopReason, "aborted");
    assert.equal(existsSync(sentinelPath), false);
  } finally {
    rmSync(sentinelDir, { recursive: true, force: true });
  }
});

test("streamOpenCode spawns opencode and returns its output when not aborted", async () => {
  const sentinelDir = mkdtempSync(join(tmpdir(), "opencode-pi-sentinel-"));
  const sentinelPath = join(sentinelDir, "ran.marker");

  try {
    const message = await withFakeOpenCode(
      `require("node:fs").writeFileSync(${JSON.stringify(sentinelPath)}, "ran");
process.stdout.write(JSON.stringify({ type: "text", part: { text: "ok" } }) + "\\n");`,
      () => streamOpenCode(fakeModel(), fakeContext()).result(),
    );

    assert.equal(existsSync(sentinelPath), true);
    assert.equal(message.stopReason, "stop");
  } finally {
    rmSync(sentinelDir, { recursive: true, force: true });
  }
});

test("streamOpenCode never spawns opencode when the signal aborts after image file setup", async () => {
  const sentinelDir = mkdtempSync(join(tmpdir(), "opencode-pi-sentinel-"));
  const sentinelPath = join(sentinelDir, "ran.marker");

  try {
    const message = await withFakeOpenCode(
      `require("node:fs").writeFileSync(${JSON.stringify(sentinelPath)}, "ran");`,
      () =>
        streamOpenCode(fakeModel(), fakeContext(), {
          signal: abortAfterSecondCheck(),
        }).result(),
    );

    assert.equal(message.stopReason, "aborted");
    assert.equal(existsSync(sentinelPath), false);
  } finally {
    rmSync(sentinelDir, { recursive: true, force: true });
  }
});

test("streamOpenCode succeeds when opencode emits reasoning-only output with no text or tool calls", async () => {
  const message = await withFakeOpenCode(
    `process.stdout.write(JSON.stringify({ type: "reasoning", part: { text: "thinking it through" } }) + "\\n");`,
    () => streamOpenCode(fakeModel(), fakeContext()).result(),
  );

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
});

test("streamOpenCode returns the expected error outcome when opencode times out", async () => {
  const message = await withFakeOpenCode(
    "setInterval(() => undefined, 1_000);",
    () =>
      streamOpenCode(fakeModel(), fakeContext(), {
        timeoutMs: 30,
      }).result(),
  );

  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "opencode timed out after 30ms");
});

test("streamOpenCode forwards reasoning settings and image files to opencode", async () => {
  const captureDir = mkdtempSync(join(tmpdir(), "opencode-pi-capture-"));
  const capturePath = join(captureDir, "invocation.json");
  const model: Model<Api> = {
    ...fakeModel(),
    reasoning: true,
    input: ["text", "image"],
    thinkingLevelMap: { high: "max" },
  };

  try {
    const message = await withFakeOpenCode(
      `const fs = require("node:fs");
const args = process.argv.slice(2);
const fileIndex = args.indexOf("--file");
const imagePath = args[fileIndex + 1];
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  args,
  imagePath,
  imageHex: fs.readFileSync(imagePath).toString("hex"),
}));
process.stdout.write(JSON.stringify({ type: "text", part: { text: "ok" } }) + "\\n");`,
      () =>
        streamOpenCode(
          model,
          imageContext("image/png", Buffer.from("image bytes").toString("base64")),
          { reasoning: "high" },
        ).result(),
    );

    const invocation = JSON.parse(readFileSync(capturePath, "utf8")) as {
      args: string[];
      imagePath: string;
      imageHex: string;
    };
    assert.equal(message.stopReason, "stop");
    assert.deepEqual(invocation.args.slice(0, 8), [
      "run",
      "--pure",
      "-m",
      "opencode/fake-free",
      "--agent",
      "pi-model",
      "--format",
      "json",
    ]);
    assert.deepEqual(invocation.args.slice(-5), [
      "--thinking",
      "--variant",
      "max",
      "--file",
      invocation.imagePath,
    ]);
    assert.equal(invocation.imagePath.endsWith("pi-images/image-001.png"), true);
    assert.equal(
      invocation.imageHex,
      Buffer.from("image bytes").toString("hex"),
    );
  } finally {
    rmSync(captureDir, { recursive: true, force: true });
  }
});

test("streamOpenCode rejects unsupported image types before provider execution", async () => {
  const { message, spawned } = await invalidImageResult(
    "application/octet-stream",
    "aGVsbG8=",
  );

  assert.equal(message.stopReason, "error");
  assert.equal(
    message.errorMessage,
    "Unsupported image MIME type: application/octet-stream",
  );
  assert.equal(spawned, false);
});

test("streamOpenCode rejects malformed encoded images before provider execution", async () => {
  const { message, spawned } = await invalidImageResult("image/png", "%%%=");

  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "Invalid base64 data for image 1");
  assert.equal(spawned, false);
});

test("streamOpenCode rejects empty decoded images before provider execution", async () => {
  const { message, spawned } = await invalidImageResult("image/png", "==");

  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "Empty image data for image 1");
  assert.equal(spawned, false);
});

test("discoverModels bypasses opencode discovery when OPENCODE_PI_MODELS is set", async () => {
  const sentinelDir = mkdtempSync(join(tmpdir(), "opencode-pi-sentinel-"));
  const sentinelPath = join(sentinelDir, "ran.marker");
  const previousModels = process.env.OPENCODE_PI_MODELS;
  process.env.OPENCODE_PI_MODELS = "custom-model-a, opencode/custom-model-b";

  try {
    const { models, error } = await withFakeOpenCode(
      `require("node:fs").writeFileSync(${JSON.stringify(sentinelPath)}, "ran");`,
      () => discoverModels(),
    );

    assert.equal(existsSync(sentinelPath), false);
    assert.equal(error, undefined);
    assert.deepEqual(
      models.map((model) => model.id),
      ["opencode/custom-model-a", "opencode/custom-model-b"],
    );
  } finally {
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

test("extension registration preserves discovered model capabilities", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  delete process.env.OPENCODE_PI_MODELS;
  let providerId: string | undefined;
  let providerConfig:
    | Parameters<ExtensionAPI["registerProvider"]>[1]
    | undefined;

  try {
    await withFakeOpenCode(
      `process.stdout.write([
  "opencode/capable-free",
  JSON.stringify({
    name: "Capable Model",
    limit: { context: 196000, output: 24576 },
    capabilities: { reasoning: true, input: { text: true, image: true } },
    variants: { off: {}, low: {}, high: {}, max: {} },
  }),
].join("\\n"));`,
      () =>
        opencodePiExtension({
          registerProvider(
            id: string,
            config: Parameters<ExtensionAPI["registerProvider"]>[1],
          ) {
            providerId = id;
            providerConfig = config;
          },
          on() {},
          registerCommand() {},
        } as unknown as ExtensionAPI),
    );

    assert.equal(providerId, "opencode-cli");
    assert.deepEqual(providerConfig?.models, [
      {
        id: "opencode/capable-free",
        name: "Capable Model (OpenCode CLI)",
        reasoning: true,
        thinkingLevelMap: {
          off: "off",
          minimal: null,
          low: "low",
          medium: null,
          high: "high",
          xhigh: "max",
        },
        input: ["text", "image"],
        contextWindow: 196000,
        maxTokens: 24576,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
  } finally {
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
  }
});

test("extension registration resolves the API handler for inference", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  delete process.env.OPENCODE_PI_MODELS;

  try {
    await withFakeOpenCode(
      `process.stdout.write("opencode/one-free\\n");`,
      () =>
        opencodePiExtension({
          registerProvider() {},
          on() {},
          registerCommand() {},
        } as unknown as ExtensionAPI),
    );

    const apiProvider = getApiProvider("opencode-cli-runner");
    assert.notEqual(apiProvider, undefined);
    assert.equal(typeof apiProvider?.streamSimple, "function");
    assert.equal(typeof apiProvider?.stream, "function");
  } finally {
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
    clearApiProviders();
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
