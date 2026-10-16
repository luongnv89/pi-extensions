import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeContext } from "@earendil-works/pi-ai";
import {
  getApiProvider,
  unregisterApiProviders,
} from "@earendil-works/pi-ai/compat";
import type {
  Api,
  AssistantMessageEvent,
  Context,
  Message,
  Model,
} from "@earendil-works/pi-ai";
import opencodePiExtension, {
  cleanupPiSessionState,
  deleteOpenCodeSession,
  discoverModels,
  imageContentsForModel,
  isActiveModel,
  isFreeModel,
  parseApiModels,
  parseModelCost,
  parseModelList,
  parseVerboseModels,
  piArguments,
  openCodeToolArgs,
  reasoningCliArgs,
  resolveTurnTimeoutMs,
  streamOpenCode,
  showOpenCodePanelList,
  trackedPiSessionCount,
  writeBridgeConfig,
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
  version = "opencode v1.0.0",
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "opencode-pi-fake-bin-"));
  const binPath = join(dir, "opencode-fake.js");
  writeFileSync(binPath, `#!/usr/bin/env node\nif (process.argv[2] === "--version") { process.stdout.write(${JSON.stringify(version)}); process.exit(0); }\n${script}`, "utf8");
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
      cost: { input: 99, output: 99, cacheRead: 0, cacheWrite: 0 },
      costFromMetadata: true,
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

function toolWithSchema(name: string, parameters: unknown): NonNullable<Context["tools"]>[number] {
  return { name, description: `${name} tool`, parameters } as NonNullable<Context["tools"]>[number];
}

test("openCodeToolArgs keeps required arguments and makes optional ones nullable", () => {
  const tool = toolWithSchema("read", {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      limit: { type: "number", description: "Max lines" },
    },
    required: ["path"],
  });
  assert.deepEqual(openCodeToolArgs(tool), {
    path: { type: "string", description: "File path" },
    limit: {
      description: "Max lines Optional: pass null to leave it unset.",
      anyOf: [{ type: "number", description: "Max lines" }, { type: "null" }],
    },
  });
  assert.deepEqual(piArguments(tool, { path: "a.txt", limit: null }), { path: "a.txt" });
  assert.deepEqual(piArguments(tool, { path: "a.txt", limit: 5 }), { path: "a.txt", limit: 5 });
  assert.deepEqual(piArguments(tool, "not an object"), {});
});

test("writeBridgeConfig declares optional Pi arguments as optional zod arguments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-pi-config-"));
  try {
    // A stand-in for the @opencode-ai/plugin package OpenCode installs.
    const plugin = join(dir, ".opencode", "node_modules", "@opencode-ai", "plugin");
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "@opencode-ai/plugin", type: "module", main: "index.js" }));
    writeFileSync(
      join(plugin, "index.js"),
      `const any = () => ({ meta: (schema) => ({ schema, optional() { return { schema, optional: true }; } }) });
export const tool = { schema: { any } };
`,
    );
    await writeBridgeConfig(dir, [
      toolWithSchema("bash", {
        type: "object",
        properties: { command: { type: "string" }, timeout: { type: "number", minimum: 1 } },
        required: ["command"],
      }),
    ]);
    const bash = (await import(pathToFileURL(join(dir, ".opencode", "tools", "bash.js")).href)).default;
    assert.deepEqual(JSON.parse(JSON.stringify(bash.args)), {
      command: { schema: { type: "string" } },
      timeout: { schema: { type: "number", minimum: 1 }, optional: true },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeBridgeConfig exposes only Pi tools and inert stubs to OpenCode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-pi-config-"));
  try {
    const tools = [
      toolWithSchema("bash", { type: "object", properties: { command: { type: "string" } }, required: ["command"] }),
      toolWithSchema("write", { type: "object", properties: {} }),
    ];
    // Stale files from an earlier tool set must not survive.
    await writeBridgeConfig(dir, [toolWithSchema("old_tool", {})]);
    await writeBridgeConfig(dir, tools);

    const toolsDir = join(dir, ".opencode", "tools");
    assert.deepEqual(
      readdirSync(toolsDir).sort(),
      [
        "apply_patch.js", "bash.js", "edit.js", "list_mcp_resource_templates.js",
        "list_mcp_resources.js", "read.js", "read_mcp_resource.js", "write.js",
      ],
    );
    const agent = readFileSync(join(dir, ".opencode", "agents", "pi-model.md"), "utf8");
    assert.match(agent, /permission:\n  "\*": deny\n/);
    for (const key of ["read", "bash", "edit"]) {
      assert.match(agent, new RegExp(`\\n  "${key}": allow\\n`));
    }
    assert.match(agent, /\n  "pi_tool": ask\n/);

    // A Pi tool only asks for the auto-rejected pi_tool permission.
    const bash = (await import(pathToFileURL(join(toolsDir, "bash.js")).href)).default;
    assert.deepEqual(bash.args, { command: { type: "string" } });
    const asks: unknown[] = [];
    await assert.rejects(
      bash.execute({ command: "rm -rf /" }, {
        ask: async (input: unknown) => {
          asks.push(input);
          throw new Error("rejected");
        },
      }),
      /rejected/,
    );
    assert.deepEqual(asks, [{ permission: "pi_tool", patterns: ["*"], always: [], metadata: {} }]);

    // Stubs that are not Pi tools only return a message.
    const read = (await import(pathToFileURL(join(toolsDir, "read.js")).href)).default;
    assert.deepEqual(read.args, {});
    assert.equal(await read.execute({}, {}), "Unavailable in this session. Use only these tools: bash, write.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeBridgeConfig refuses Pi tool names OpenCode cannot load", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-pi-config-"));
  try {
    await assert.rejects(
      writeBridgeConfig(dir, [toolWithSchema("../escape", {})]),
      /not a valid OpenCode tool name/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("streamOpenCode turns OpenCode tool_use events into Pi tool calls", async () => {
  const context: Context = {
    messages: [],
    tools: [
      toolWithSchema("read", {
        type: "object",
        properties: { path: { type: "string" }, limit: { type: "number" } },
        required: ["path"],
      }),
    ],
  };
  const events = await collectStreamEvents(
    fakeEventScript([
      { type: "text", part: { text: "Reading it." } },
      {
        type: "tool_use",
        part: { tool: "read", callID: "call_1", state: { status: "error", input: { path: "README.md", limit: null } } },
      },
      // A call to an unavailable stub already got its answer inside OpenCode.
      { type: "tool_use", part: { tool: "apply_patch", callID: "call_2", state: { status: "completed", input: {} } } },
      { type: "step_finish", part: { reason: "tool-calls" } },
    ]),
    context,
  );

  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "text_start", "text_delta", "text_end", "toolcall_start", "toolcall_delta", "toolcall_end", "done"],
  );
  const done = events.at(-1);
  assert.equal(done?.type, "done");
  if (done?.type !== "done") return;
  assert.equal(done.reason, "toolUse");
  assert.deepEqual(done.message.content, [
    { type: "text", text: "Reading it." },
    { type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } },
  ]);
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

test("streamOpenCode uses v2 model variants and isolated project agent without v1 flags", async () => {
  const captureDir = mkdtempSync(join(tmpdir(), "opencode-pi-v2-capture-"));
  const capturePath = join(captureDir, "invocation.json");
  const model: Model<Api> = {
    ...fakeModel(),
    reasoning: true,
    thinkingLevelMap: { low: "low" },
  };
  try {
    await withFakeOpenCode(
      `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  pwd: fs.realpathSync(process.env.PWD),
  agent: fs.readFileSync(".opencode/agents/pi-model.md", "utf8"),
}));
process.stdout.write(JSON.stringify({ type: "text", part: { text: "ok" } }) + "\\n");`,
      async () => {
        const message = await streamOpenCode(model, fakeContext(), { reasoning: "low" }).result();
        assert.equal(message.stopReason, "stop");
      },
      "opencode v2.0.16",
    );
    const invocation = JSON.parse(readFileSync(capturePath, "utf8")) as {
      args: string[];
      cwd: string;
      pwd: string;
      agent: string;
    };
    // v2 reads the project directory from PWD, not the process cwd.
    assert.equal(invocation.pwd, invocation.cwd);
    assert.deepEqual(invocation.args, [
      "run", "--standalone", "-m", "opencode/fake-free#low",
      "--agent", "pi-model", "--format", "json", "--thinking",
    ]);
    assert.match(invocation.agent, /mode: primary/);
    // v2 would run its own tools under any allow rule.
    assert.match(invocation.agent, /permission:\n  "\*": ask\n---/);
    assert.match(invocation.cwd, /opencode-pi-/);
  } finally {
    rmSync(captureDir, { recursive: true, force: true });
  }
});

test("streamOpenCode ends an OpenCode v2 run once Pi's tool calls are in", async () => {
  const started = Date.now();
  const message = await withFakeOpenCode(
    `if (process.argv[2] === "session") process.exit(0);
process.stdin.resume();
process.stdin.on("end", () => {
  const emit = (type, part) => process.stdout.write(JSON.stringify({ type, sessionID: "ses-v2", part }) + "\\n");
  emit("tool_use", { partID: "prt_tool", type: "tool", id: "call_v2", tool: "read", state: { status: "error", input: { path: "a.txt" } } });
  emit("tool_use", { partID: "prt_sh", type: "tool", id: "call_sh", tool: "shell", state: { status: "error", input: { command: "ls", workdir: "/" } } });
  emit("step_finish", { id: "prt_f", type: "step-finish", reason: "tool-calls" });
  // v2 hands the rejection back to the model, which then guesses.
  emit("text", { id: "prt_t", type: "text", text: "a.txt does not exist." });
  setInterval(() => undefined, 1_000);
});`,
    () =>
      streamOpenCode(fakeModel(), {
        messages: [],
        tools: [
          toolWithSchema("read", { type: "object", properties: { path: { type: "string" } }, required: ["path"] }),
          toolWithSchema("bash", { type: "object", properties: { command: { type: "string" } }, required: ["command"] }),
        ],
      }).result(),
    "opencode v2.0.16",
  );
  assert.equal(message.stopReason, "toolUse");
  // v2's shell is Pi's bash; arguments Pi does not declare are dropped.
  assert.deepEqual(message.content, [
    { type: "toolCall", id: "call_v2", name: "read", arguments: { path: "a.txt" } },
    { type: "toolCall", id: "call_sh", name: "bash", arguments: { command: "ls" } },
  ]);
  assert.ok(Date.now() - started < 5_000);
});

test("streamOpenCode leaves v2 model ID unsuffixed without a selected variant", async () => {
  await withFakeOpenCode(
    `const args = process.argv.slice(2);
if (args[args.indexOf("-m") + 1] !== "opencode/fake-free") process.exit(1);
process.stdout.write(JSON.stringify({ type: "text", part: { text: "ok" } }) + "\\n");`,
    async () => {
      const message = await streamOpenCode(fakeModel(), fakeContext()).result();
      assert.equal(message.stopReason, "stop");
    },
    "v2.0.16",
  );
});

test("streamOpenCode refuses unknown CLI versions rather than guessing v1 flags", async () => {
  const message = await withFakeOpenCode(
    `process.exit(1);`,
    () => streamOpenCode(fakeModel(), fakeContext()).result(),
    "not a version",
  );
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /Cannot determine OpenCode CLI version/);
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
    unregisterApiProviders("opencode-cli");
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

type RecordedNotification = { message: string; level?: string };

type NotifyCtx = { ui: { notify: (msg: string, level?: string) => void } };

function sessionStartRecorder() {
  let handler:
    | ((event: unknown, ctx: unknown) => Promise<void>)
    | undefined;
  const extension = {
    registerProvider() {},
    on(event: string, registered: (event: unknown, ctx: unknown) => Promise<void>) {
      if (event === "session_start") handler = registered;
    },
    registerCommand() {},
  };
  return {
    extension: extension as unknown as ExtensionAPI,
    async run(ctx: NotifyCtx) {
      if (!handler) throw new Error("session_start handler not registered");
      await handler({}, ctx);
    },
  };
}

function recordingCtx(): {
  notifications: RecordedNotification[];
  ui: { notify: (msg: string, level?: string) => void };
} {
  const notifications: RecordedNotification[] = [];
  return {
    notifications,
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
    },
  };
}

test("session_start warns with setup guidance when the opencode binary is missing", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  delete process.env.OPENCODE_PI_MODELS;
  const previousBin = process.env.OPENCODE_PI_BIN;
  process.env.OPENCODE_PI_BIN = join(tmpdir(), "opencode-pi-does-not-exist");

  try {
    const recorder = sessionStartRecorder();
    await opencodePiExtension(recorder.extension);

    const ctx = recordingCtx();
    await recorder.run(ctx);

    const warnings = ctx.notifications.filter((n) => n.level === "warning");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!.message, /could not use the local OpenCode CLI/);
    assert.match(warnings[0]!.message, /Reason:/);
    assert.match(warnings[0]!.message, /Install OpenCode/);
    assert.equal(
      ctx.notifications.some((n) => n.level === "info"),
      false,
    );
  } finally {
    restoreEnv("OPENCODE_PI_BIN", previousBin);
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
  }
});

test("session_start flags the OPENCODE_PI_MODELS fast path when the binary is missing", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  process.env.OPENCODE_PI_MODELS = "custom-model-a";
  const previousBin = process.env.OPENCODE_PI_BIN;
  process.env.OPENCODE_PI_BIN = join(tmpdir(), "opencode-pi-does-not-exist");

  try {
    const recorder = sessionStartRecorder();
    await opencodePiExtension(recorder.extension);

    const ctx = recordingCtx();
    await recorder.run(ctx);

    const warnings = ctx.notifications.filter((n) => n.level === "warning");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!.message, /OPENCODE_PI_MODELS skipped discovery/);
    assert.match(warnings[0]!.message, /could not use the local OpenCode CLI/);
  } finally {
    restoreEnv("OPENCODE_PI_BIN", previousBin);
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
  }
});

test("session_start produces no warning when opencode answers --version", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  delete process.env.OPENCODE_PI_MODELS;

  try {
    const recorder = sessionStartRecorder();
    await withFakeOpenCode(
      `if (process.argv.includes("--version")) {
  process.stdout.write("opencode 9.9.9\\n");
  process.exit(0);
}
process.stdout.write([
  "opencode/one-free",
  JSON.stringify({ capabilities: {} }),
].join("\\n"));`,
      () => opencodePiExtension(recorder.extension),
    );

    const ctx = recordingCtx();
    await recorder.run(ctx);

    assert.deepEqual(
      ctx.notifications.filter((n) => n.level === "warning"),
      [],
    );
    const info = ctx.notifications.find((n) => n.level === "info");
    assert.match(info?.message ?? "", /registered \d+ OpenCode CLI model\(s\)/);
  } finally {
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
  }
});

test("parseModelCost reads real input, output, and cache figures", () => {
  assert.deepEqual(
    parseModelCost({
      cost: { input: 10, output: 50, cache: { read: 1, write: 12.5 } },
    }),
    { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  );
});

test("parseModelCost defaults missing or malformed figures to zero", () => {
  assert.deepEqual(parseModelCost({}), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.deepEqual(
    parseModelCost({
      cost: { input: -5, output: "free", cache: { read: NaN, write: null } },
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
});

test("parseVerboseModels records status and cost provenance", () => {
  const output = `opencode/paid-model
{
  "cost": { "input": 3, "output": 15, "cache": { "read": 0.3, "write": 3.75 } },
  "status": "active",
  "capabilities": {}
}
opencode/retired-free
{
  "cost": { "input": 0, "output": 0, "cache": { "read": 0, "write": 0 } },
  "status": "deprecated",
  "capabilities": {}
}
`;
  assert.deepEqual(parseVerboseModels(output), [
    {
      id: "opencode/paid-model",
      name: "OpenCode paid-model",
      reasoning: false,
      image: false,
      contextWindow: 128000,
      maxTokens: 16384,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      costFromMetadata: true,
      status: "active",
    },
    {
      id: "opencode/retired-free",
      name: "OpenCode retired-free",
      reasoning: false,
      image: false,
      contextWindow: 128000,
      maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costFromMetadata: true,
      status: "deprecated",
    },
  ]);
});

test("isFreeModel selects by cost metadata, not the name pattern", () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  // A free model without a -free suffix is picked up via cost metadata.
  assert.equal(
    isFreeModel({ id: "opencode/big-pickle", cost: zero, costFromMetadata: true }),
    true,
  );
  // A paid model keeps its real cost even with a -free-looking name.
  assert.equal(
    isFreeModel({
      id: "opencode/sneaky-free",
      cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
      costFromMetadata: true,
    }),
    false,
  );
  // Without cost metadata the legacy name pattern still applies.
  assert.equal(isFreeModel({ id: "opencode/old-free", cost: zero }), true);
  assert.equal(isFreeModel({ id: "opencode/old-paid", cost: zero }), false);
});

test("isActiveModel excludes non-active statuses and tolerates a missing field", () => {
  assert.equal(isActiveModel("active"), true);
  assert.equal(isActiveModel("Active"), true);
  assert.equal(isActiveModel("deprecated"), false);
  assert.equal(isActiveModel("disabled"), false);
  assert.equal(isActiveModel(undefined), true);
  assert.equal(isActiveModel(null), true);
});

test("discoverModels selects zero-cost models and skips inactive ones", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  const previousBin = process.env.OPENCODE_PI_BIN;
  delete process.env.OPENCODE_PI_MODELS;
  const dir = mkdtempSync(join(tmpdir(), "opencode-pi-fake-bin-"));
  const binPath = join(dir, "opencode-fake.js");
  writeFileSync(
    binPath,
    `#!/usr/bin/env node
process.stdout.write([
  "opencode/plain-free-name",
  JSON.stringify({
    status: "active",
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {},
  }),
  "opencode/retired-free",
  JSON.stringify({
    status: "deprecated",
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {},
  }),
  "opencode/sneaky-free",
  JSON.stringify({
    status: "active",
    cost: { input: 3, output: 15, cache: { read: 0.3, write: 0 } },
    capabilities: {},
  }),
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
      ["opencode/plain-free-name"],
    );
  } finally {
    restoreEnv("OPENCODE_PI_BIN", previousBin);
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverModels reports real cost for a configured paid model", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  const previousBin = process.env.OPENCODE_PI_BIN;
  process.env.OPENCODE_PI_MODELS = "opencode/paid-model";
  const dir = mkdtempSync(join(tmpdir(), "opencode-pi-fake-bin-"));
  const binPath = join(dir, "opencode-fake.js");
  writeFileSync(
    binPath,
    `#!/usr/bin/env node
process.stdout.write([
  "opencode/paid-model",
  JSON.stringify({
    status: "active",
    cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
    capabilities: {},
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
    assert.deepEqual(models[0]?.cost, {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
  } finally {
    restoreEnv("OPENCODE_PI_BIN", previousBin);
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverModels falls back to live free model IDs when discovery fails", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  const previousBin = process.env.OPENCODE_PI_BIN;
  delete process.env.OPENCODE_PI_MODELS;
  const dir = mkdtempSync(join(tmpdir(), "opencode-pi-fake-bin-"));
  const binPath = join(dir, "opencode-fake.js");
  writeFileSync(
    binPath,
    "#!/usr/bin/env node\nprocess.stderr.write('boom');\nprocess.exit(1);\n",
    "utf8",
  );
  chmodSync(binPath, 0o755);
  process.env.OPENCODE_PI_BIN = binPath;

  try {
    const { models, error } = await discoverModels();

    assert.notEqual(error, undefined);
    assert.deepEqual(
      models.map((model) => model.id),
      [
        "opencode/big-pickle",
        "opencode/ling-3.0-flash-fin-free",
        "opencode/mimo-v2.6-flash-free",
        "opencode/muse-spark-1.3-contributor-free",
        "opencode/nemotron-3-ultra-free",
        "opencode/nemotron-3.5-lightning-free",
        "opencode/space-bunny-free",
      ],
    );
  } finally {
    restoreEnv("OPENCODE_PI_BIN", previousBin);
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseApiModels reads the v2 /api/model payload for the opencode provider", () => {
  const models = parseApiModels(
    JSON.stringify({
      location: { directory: "/tmp" },
      data: [
        {
          id: "space-bunny-free",
          modelID: "space-bunny-free",
          providerID: "opencode",
          name: "Space Bunny Free",
          capabilities: { input: ["text", "image"] },
          variants: [
            { id: "low", settings: { reasoningEffort: "low" } },
            { id: "max", settings: { reasoningEffort: "max" } },
          ],
          cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
          status: "active",
          limit: { context: 1_048_576, output: 524_288 },
        },
        {
          id: "paid",
          modelID: "paid",
          providerID: "opencode",
          capabilities: { input: ["text"] },
          cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 0 } }],
          status: "active",
        },
        { modelID: "gpt-astra-latest", providerID: "openrouter", cost: [] },
        { modelID: "broken" },
      ],
    }),
  );

  assert.deepEqual(
    models.map((model) => model.id),
    ["opencode/space-bunny-free", "opencode/paid"],
  );
  const free = models[0];
  assert.equal(free?.name, "Space Bunny Free");
  assert.equal(free?.image, true);
  assert.equal(free?.reasoning, true);
  assert.equal(free?.contextWindow, 1_048_576);
  assert.equal(free?.maxTokens, 524_288);
  assert.equal(free?.costFromMetadata, true);
  assert.deepEqual(free?.thinkingLevelMap, {
    minimal: null,
    low: "low",
    medium: null,
    high: null,
    xhigh: "max",
  });
  assert.equal(isFreeModel(free!), true);
  assert.equal(isFreeModel(models[1]!), false);
  assert.deepEqual(models[1]?.cost, {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 0,
  });
});

test("parseApiModels and parseModelList ignore unusable output", () => {
  assert.deepEqual(parseApiModels("Unrecognized flag: --verbose"), []);
  assert.deepEqual(parseApiModels("{}"), []);
  assert.deepEqual(
    parseModelList(
      ["opencode/big-pickle", "opencode/space-bunny-free", "opencode/space-bunny-free", "openrouter/x", "", "ERROR"].join("\n"),
    ),
    ["opencode/big-pickle", "opencode/space-bunny-free"],
  );
});

test("discoverModels prefers the v2 API and ignores the removed --verbose flag", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  const previousBin = process.env.OPENCODE_PI_BIN;
  delete process.env.OPENCODE_PI_MODELS;
  const dir = mkdtempSync(join(tmpdir(), "opencode-pi-fake-bin-"));
  const binPath = join(dir, "opencode-fake.js");
  writeFileSync(
    binPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "api" && args[1] === "GET" && args[2] === "/api/model") {
  process.stdout.write(JSON.stringify({
    data: [
      {
        modelID: "space-bunny-free",
        providerID: "opencode",
        name: "Space Bunny Free",
        capabilities: { input: ["text"] },
        cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
        status: "active",
        limit: { context: 1_048_576, output: 524_288 },
      },
      {
        modelID: "paid-model",
        providerID: "opencode",
        cost: [{ input: 3, output: 15 }],
        status: "active",
      },
    ],
  }));
  process.exit(0);
}
if (args[0] === "run") {
  process.stdout.write(JSON.stringify({ type: "text", part: { text: JSON.stringify(args) } }) + "\\n");
  process.exit(0);
}
process.stderr.write("Unrecognized flag: --verbose in command opencode models\\n");
process.exit(1);
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
      ["opencode/space-bunny-free"],
    );
    assert.equal(models[0]?.contextWindow, 1_048_576);
    // The successful API transport identifies v2 even if --version is unavailable.
    const message = await streamOpenCode(
      { ...fakeModel(), id: models[0]!.id, thinkingLevelMap: { low: "low" } },
      fakeContext(),
      { reasoning: "low" },
    ).result();
    assert.equal(message.stopReason, "stop");
    const args = JSON.parse((message.content[0] as { text: string }).text) as string[];
    assert.deepEqual(args.slice(0, 4), ["run", "--standalone", "-m", "opencode/space-bunny-free#low"]);
    assert.equal(args.includes("--pure"), false);
  } finally {
    restoreEnv("OPENCODE_PI_BIN", previousBin);
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverModels retries the v2 API when a cold service answers with no models", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  const previousBin = process.env.OPENCODE_PI_BIN;
  const previousCounter = process.env.OC_TEST_COUNTER;
  delete process.env.OPENCODE_PI_MODELS;
  const dir = mkdtempSync(join(tmpdir(), "opencode-pi-fake-bin-"));
  const binPath = join(dir, "opencode-fake.js");
  writeFileSync(
    binPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const counter = process.env.OC_TEST_COUNTER;
if (args[0] === "api" && args[1] === "GET" && args[2] === "/api/model") {
  const seen = require("node:fs").existsSync(counter);
  require("node:fs").writeFileSync(counter, "1");
  if (!seen) {
    process.stdout.write(JSON.stringify({ data: [] }));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    data: [
      {
        modelID: "space-bunny-free",
        providerID: "opencode",
        cost: [{ input: 0, output: 0 }],
        status: "active",
      },
    ],
  }));
  process.exit(0);
}
process.exit(1);
`,
    "utf8",
  );
  chmodSync(binPath, 0o755);
  process.env.OPENCODE_PI_BIN = binPath;
  process.env.OC_TEST_COUNTER = join(dir, "called");

  try {
    const { models, error } = await discoverModels();

    assert.equal(error, undefined);
    assert.deepEqual(
      models.map((model) => model.id),
      ["opencode/space-bunny-free"],
    );
  } finally {
    restoreEnv("OPENCODE_PI_BIN", previousBin);
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
    restoreEnv("OC_TEST_COUNTER", previousCounter);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverModels falls back to the plain model ID list when metadata is unavailable", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  const previousBin = process.env.OPENCODE_PI_BIN;
  delete process.env.OPENCODE_PI_MODELS;
  const dir = mkdtempSync(join(tmpdir(), "opencode-pi-fake-bin-"));
  const binPath = join(dir, "opencode-fake.js");
  writeFileSync(
    binPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "api") process.exit(1);
if (args[0] === "--version") { process.stdout.write("opencode v2.0.16"); process.exit(0); }
if (args[1] === "--verbose") {
  process.stderr.write("Unrecognized flag: --verbose in command opencode models\\n");
  process.exit(1);
}
process.stdout.write(["opencode/big-pickle", "opencode/space-bunny-free", "opencode/paid-model"].join("\\n"));
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
      ["opencode/big-pickle", "opencode/space-bunny-free"],
    );
    assert.equal(models[0]?.costFromMetadata, undefined);
  } finally {
    restoreEnv("OPENCODE_PI_BIN", previousBin);
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plain-list discovery selects run flags from the installed CLI version", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  delete process.env.OPENCODE_PI_MODELS;
  try {
    for (const [version, expected] of [
      ["opencode v2.0.16", ["run", "--standalone", "-m", "opencode/space-bunny-free#low", "--agent", "pi-model", "--format", "json", "--thinking"]],
      ["opencode v1.2.0", ["run", "--pure", "-m", "opencode/space-bunny-free", "--agent", "pi-model", "--format", "json", "--dir"]],
    ] as const) {
      await withFakeOpenCode(
        `const args = process.argv.slice(2);
if (args[0] === "api" || args.includes("--verbose")) process.exit(1);
if (args[0] === "models") { process.stdout.write("opencode/space-bunny-free\\n"); process.exit(0); }
if (args[0] === "run") {
  process.stdout.write(JSON.stringify({ type: "text", part: { text: JSON.stringify(args) } }) + "\\n");
  process.exit(0);
}
process.exit(1);`,
        async () => {
          const { models, error } = await discoverModels();
          assert.equal(error, undefined);
          const message = await streamOpenCode(
            { ...fakeModel(), id: models[0]!.id, thinkingLevelMap: { low: "low" } },
            fakeContext(),
            { reasoning: "low" },
          ).result();
          assert.equal(message.stopReason, "stop");
          const args = JSON.parse((message.content[0] as { text: string }).text) as string[];
          assert.deepEqual(args.slice(0, expected.length), expected);
          if (version.includes("v2")) {
            assert.equal(args.includes("--dir"), false);
            assert.equal(args.includes("--variant"), false);
            assert.equal(args.includes("--pure"), false);
          } else {
            assert.deepEqual(args.slice(-3), ["--thinking", "--variant", "low"]);
          }
        },
        version,
      );
    }
  } finally {
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
  }
});

test("resolveTurnTimeoutMs honors Pi timeouts and bounds unbounded turns", () => {
  assert.equal(resolveTurnTimeoutMs(30), 30);
  assert.equal(resolveTurnTimeoutMs(600_000), 600_000);
  assert.equal(resolveTurnTimeoutMs(undefined), 180_000);
  assert.equal(resolveTurnTimeoutMs(0), 180_000);
  assert.equal(resolveTurnTimeoutMs(-5), 180_000);
  assert.equal(resolveTurnTimeoutMs(Number.NaN), 180_000);
  assert.equal(resolveTurnTimeoutMs(Number.POSITIVE_INFINITY), 180_000);
});

test("streamOpenCode detaches the abort listener on the error path", async () => {
  let added = 0;
  let removed = 0;
  const signal = {
    aborted: false,
    addEventListener() {
      added += 1;
    },
    removeEventListener() {
      removed += 1;
    },
  } as unknown as AbortSignal;

  const message = await withFakeOpenCode(
    fakeEventScript([{ type: "error", error: { data: { message: "boom" } } }]),
    () =>
      streamOpenCode(fakeModel(), fakeContext(["read"]), { signal }).result(),
  );

  assert.equal(message.stopReason, "error");
  assert.equal(added, 1);
  assert.equal(removed, 1);
});

test("streamOpenCode detaches the abort listener on the timeout path", async () => {
  let added = 0;
  let removed = 0;
  const signal = {
    aborted: false,
    addEventListener() {
      added += 1;
    },
    removeEventListener() {
      removed += 1;
    },
  } as unknown as AbortSignal;

  const message = await withFakeOpenCode(
    "setInterval(() => undefined, 1_000);",
    () =>
      streamOpenCode(fakeModel(), fakeContext(), {
        signal,
        timeoutMs: 30,
      }).result(),
  );

  assert.equal(message.stopReason, "error");
  assert.equal(added, 1);
  assert.equal(removed, 1);
});

// A fake `opencode` binary that records every invocation (args + stdin) and
// answers turns with a fixed session ID, so session-reuse tests can assert
// continuation args, delta-only prompts, and directory stability. The
// fire-and-forget `session delete` helper hits the same binary and must not
// pollute the capture log.
function sessionFakeScript(capturePath: string, sessionId: string): string {
  return `const fs = require("node:fs");
if (process.argv.includes("session")) process.exit(0);
let body = "";
process.stdin.on("data", (chunk) => { body += chunk; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const dir = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : process.cwd();
  const tools = fs.readdirSync(require("node:path").join(dir, ".opencode", "tools")).sort();
  fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ args, stdin: body, tools }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "text", part: { text: "hello" }, sessionID: ${JSON.stringify(sessionId)} }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "step_finish", part: { reason: "stop", tokens: { total: 10, input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } }, sessionID: ${JSON.stringify(sessionId)} }) + "\\n");
});
`;
}

function readInvocations(capturePath: string): { args: string[]; stdin: string; tools?: string[] }[] {
  if (!existsSync(capturePath)) return [];
  return readFileSync(capturePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function userContext(texts: string[], toolNames: string[] = []): Context {
  return {
    messages: texts.map((text, index) => ({
      role: "user" as const,
      content: text,
      timestamp: index + 1,
    })),
    tools: toolNames.map((name) => ({
      name,
      description: `${name} tool`,
      parameters: {},
    })) as Context["tools"],
  };
}

function conversationContext(): Context {
  return {
    messages: [
      { role: "user", content: "first question", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text" as const, text: "hello" }],
        timestamp: 2,
      } as unknown as Context["messages"][number],
      { role: "user", content: "second question", timestamp: 3 },
    ],
  };
}

test("streamOpenCode replays Pi system messages into the prompt and tools", async () => {
  const captureDir = mkdtempSync(join(tmpdir(), "opencode-pi-capture-"));
  const capturePath = join(captureDir, "invocations.jsonl");
  // Pi 1.3 hands providers the prompt and tools as transcript system messages.
  const context = normalizeContext({
    systemPrompt: "BASE PROMPT",
    tools: fakeContext(["read"]).tools,
    messages: [
      { role: "user", content: "first question", timestamp: 1 },
      { role: "system", content: "LATER INSTRUCTION", toolsAdded: fakeContext(["bash"]).tools, timestamp: 2 },
      { role: "user", content: "second question", timestamp: 3 },
    ],
  });
  try {
    const message = await withFakeOpenCode(
      sessionFakeScript(capturePath, "ses-system-1"),
      () => streamOpenCode(fakeModel(), context).result(),
    );
    assert.equal(message.stopReason, "stop");
    const invocation = readInvocations(capturePath)[0];
    const stdin = invocation?.stdin ?? "";
    assert.match(stdin, /BASE PROMPT/);
    assert.match(stdin, /LATER INSTRUCTION/);
    assert.ok(invocation?.tools?.includes("read.js"));
    assert.ok(invocation?.tools?.includes("bash.js"));
    assert.match(stdin, /USER:\nfirst question[\s\S]*USER:\nsecond question/);
    assert.equal(stdin.includes("SYSTEM:"), false);
  } finally {
    rmSync(captureDir, { recursive: true, force: true });
  }
});

test("streamOpenCode reuses the session and sends only the transcript delta", async () => {
  const captureDir = mkdtempSync(join(tmpdir(), "opencode-pi-capture-"));
  const capturePath = join(captureDir, "invocations.jsonl");
  const piSessionId = `pi-reuse-${Date.now()}`;
  try {
    const first = await withFakeOpenCode(
      sessionFakeScript(capturePath, "ses-reuse-1"),
      () =>
        streamOpenCode(fakeModel(), userContext(["first question"]), {
          sessionId: piSessionId,
        }).result(),
    );
    assert.equal(first.stopReason, "stop");

    const second = await withFakeOpenCode(
      sessionFakeScript(capturePath, "ses-reuse-1"),
      () =>
        streamOpenCode(fakeModel(), conversationContext(), {
          sessionId: piSessionId,
        }).result(),
    );
    assert.equal(second.stopReason, "stop");

    const invocations = readInvocations(capturePath);
    assert.equal(invocations.length, 2);
    // First turn starts a fresh session with the full transcript.
    assert.equal(invocations[0]?.args.includes("--session"), false);
    assert.match(invocations[0]?.stdin ?? "", /first question/);
    // Continuation passes --session, reuses the directory, and sends the delta.
    const sessionIndex = invocations[1]?.args.indexOf("--session") ?? -1;
    assert.notEqual(sessionIndex, -1);
    assert.equal(invocations[1]?.args[sessionIndex + 1], "ses-reuse-1");
    assert.match(invocations[1]?.stdin ?? "", /second question/);
    assert.equal((invocations[1]?.stdin ?? "").includes("first question"), false);
    // The previous reply is already in the OpenCode session.
    assert.equal((invocations[1]?.stdin ?? "").includes("hello"), false);
    const dirIndex = (args: string[]) => args.indexOf("--dir");
    assert.equal(
      invocations[1]?.args[dirIndex(invocations[1]?.args ?? []) + 1],
      invocations[0]?.args[dirIndex(invocations[0]?.args ?? []) + 1],
    );
    assert.equal(trackedPiSessionCount() >= 1, true);
  } finally {
    await cleanupPiSessionState(piSessionId);
    rmSync(captureDir, { recursive: true, force: true });
  }
});

test("streamOpenCode starts fresh after an error drops the session", async () => {
  const captureDir = mkdtempSync(join(tmpdir(), "opencode-pi-capture-"));
  const capturePath = join(captureDir, "invocations.jsonl");
  const piSessionId = `pi-drop-${Date.now()}`;
  try {
    const first = await withFakeOpenCode(
      sessionFakeScript(capturePath, "ses-drop-1"),
      () =>
        streamOpenCode(fakeModel(), userContext(["first question"]), {
          sessionId: piSessionId,
        }).result(),
    );
    assert.equal(first.stopReason, "stop");

    // A failed turn (OpenCode error event) drops the recorded session.
    const failed = await withFakeOpenCode(
      `const fs = require("node:fs");
if (process.argv.includes("session")) process.exit(0);
let body = "";
process.stdin.on("data", (chunk) => { body += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ args: process.argv.slice(2), stdin: body }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "error", sessionID: "ses-drop-1", error: { data: { message: "boom" } } }) + "\\n");
});
`,
      () =>
        streamOpenCode(fakeModel(), userContext(["boom"]), {
          sessionId: piSessionId,
        }).result(),
    );
    assert.equal(failed.stopReason, "error");

    const recovered = await withFakeOpenCode(
      sessionFakeScript(capturePath, "ses-drop-2"),
      () =>
        streamOpenCode(fakeModel(), userContext(["third question"]), {
          sessionId: piSessionId,
        }).result(),
    );
    assert.equal(recovered.stopReason, "stop");

    const invocations = readInvocations(capturePath);
    assert.equal(invocations.length, 3);
    // The recovery turn starts a fresh full-transcript session.
    assert.equal(invocations[2]?.args.includes("--session"), false);
    assert.match(invocations[2]?.stdin ?? "", /Conversation transcript/);
  } finally {
    await cleanupPiSessionState(piSessionId);
    rmSync(captureDir, { recursive: true, force: true });
  }
});

test("streamOpenCode restarts the session when tools change", async () => {
  const captureDir = mkdtempSync(join(tmpdir(), "opencode-pi-capture-"));
  const capturePath = join(captureDir, "invocations.jsonl");
  const piSessionId = `pi-tools-${Date.now()}`;
  try {
    const first = await withFakeOpenCode(
      sessionFakeScript(capturePath, "ses-tools-1"),
      () =>
        streamOpenCode(fakeModel(), userContext(["q1"], ["read"]), {
          sessionId: piSessionId,
        }).result(),
    );
    assert.equal(first.stopReason, "stop");

    const second = await withFakeOpenCode(
      sessionFakeScript(capturePath, "ses-tools-2"),
      () =>
        streamOpenCode(fakeModel(), userContext(["q1", "q2"], ["read", "bash"]), {
          sessionId: piSessionId,
        }).result(),
    );
    assert.equal(second.stopReason, "stop");

    const invocations = readInvocations(capturePath);
    assert.equal(invocations.length, 2);
    // A changed tool list restarts with the full transcript, not a delta.
    assert.equal(invocations[1]?.args.includes("--session"), false);
    assert.ok(invocations[0]?.tools?.includes("read.js"));
    assert.equal(invocations[0]?.tools?.includes("bash.js"), false);
    assert.ok(invocations[1]?.tools?.includes("bash.js"));
    assert.match(invocations[1]?.stdin ?? "", /q1/);
  } finally {
    await cleanupPiSessionState(piSessionId);
    rmSync(captureDir, { recursive: true, force: true });
  }
});

test("streamOpenCode runs isolated fresh sessions without a Pi session ID", async () => {
  const captureDir = mkdtempSync(join(tmpdir(), "opencode-pi-capture-"));
  const capturePath = join(captureDir, "invocations.jsonl");
  try {
    for (const question of ["q1", "q2"]) {
      const message = await withFakeOpenCode(
        sessionFakeScript(capturePath, "ses-once"),
        () => streamOpenCode(fakeModel(), userContext([question])).result(),
      );
      assert.equal(message.stopReason, "stop");
    }
    const invocations = readInvocations(capturePath);
    assert.equal(invocations.length, 2);
    for (const invocation of invocations) {
      assert.equal(invocation.args.includes("--session"), false);
      assert.match(invocation.stdin, /Conversation transcript/);
    }
    assert.notEqual(
      invocationDir(invocations[0]),
      invocationDir(invocations[1]),
    );
    function invocationDir(invocation: { args: string[] }): string {
      return invocation.args[invocation.args.indexOf("--dir") + 1] ?? "";
    }
  } finally {
    rmSync(captureDir, { recursive: true, force: true });
  }
});

test("deleteOpenCodeSession never throws without a session ID", () => {
  assert.doesNotThrow(() => deleteOpenCodeSession(undefined));
});

test("cleanupPiSessionState removes the project directory at teardown", async () => {
  const captureDir = mkdtempSync(join(tmpdir(), "opencode-pi-capture-"));
  const capturePath = join(captureDir, "invocations.jsonl");
  const piSessionId = `pi-teardown-${Date.now()}`;
  let before = 0;
  try {
    await withFakeOpenCode(
      sessionFakeScript(capturePath, "ses-teardown-1"),
      () =>
        streamOpenCode(fakeModel(), userContext(["hello"]), {
          sessionId: piSessionId,
        }).result(),
    );
    before = trackedPiSessionCount();
    assert.equal(before >= 1, true);
    const invocations = readInvocations(capturePath);
    const dir = invocations[0]?.args[invocations[0]?.args.indexOf("--dir") + 1];
    assert.equal(existsSync(dir), true);

    await cleanupPiSessionState(piSessionId);

    assert.equal(existsSync(dir), false);
    assert.equal(trackedPiSessionCount(), before - 1);
  } finally {
    await cleanupPiSessionState(piSessionId);
    rmSync(captureDir, { recursive: true, force: true });
  }
});

test("detail pagination bounds options, traverses duplicates, and preserves exits", async () => {
  const records = ["Back", "Next", "Close", "Previous", "Back"];
  const actions = ["detail", ...Array.from({ length: 4 }, () => ["Next", "detail"]).flat(), "Next", ...Array(4).fill("Previous"), "Previous", "Back"];
  const pages: number[] = [];
  const result = await showOpenCodePanelList({ ui: { select: async (title: string, options: string[]) => {
    assert.ok(pages.length < actions.length);
    const previous = pages.at(-1) ?? 1;
    const action = actions[pages.length - 1];
    const page = pages.length === 0 ? 1 : action === "Next" ? Math.min(5, previous + 1) : action === "Previous" ? Math.max(1, previous - 1) : previous;
    pages.push(page);
    assert.equal(title, `Details (${page}/5)`);
    assert.deepEqual(options, [`• ${records[page - 1]}`, ...(page > 1 ? ["Previous"] : []), ...(page < 5 ? ["Next"] : []), "Back", "Close"]);
    assert.ok(options.length <= 5);
    return actions[pages.length - 1] === "detail" ? options[0] : actions[pages.length - 1];
  } } }, "Details", records);
  assert.equal(result, "back");
  assert.deepEqual(pages, [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 5, 4, 3, 2, 1, 1]);
  for (const [lines, answer, detail, outcome] of [
    [[], "Back", "No details available.", "back"],
    [["Close"], "Close", "Close", "close"],
    [["Previous"], undefined, "Previous", "close"],
  ] as [string[], string | undefined, string, string][]) {
    let calls = 0;
    assert.equal(await showOpenCodePanelList({ ui: { select: async (title: string, options: string[]) => {
      calls++;
      assert.equal(title, "Details (1/1)");
      assert.deepEqual(options, [`• ${detail}`, "Back", "Close"]);
      return answer;
    } } }, "Details", lines), outcome);
    assert.equal(calls, 1);
  }
});

test("long ASCII details retain every character in order with short titles and bounded options", async () => {
  const records = ["Back", "Credentials: managed externally by OpenCode CLI (contents not read)", "Next", "z".repeat(91), "Close"];
  const segments: string[] = [];
  await showOpenCodePanelList({ ui: { select: async (title: string, options: string[]) => {
    assert.ok(title.length <= 38);
    assert.ok(title.startsWith("opencode-pi configuration ("));
    assert.ok(options.length <= 5);
    assert.ok(options[0]?.startsWith("• "));
    segments.push(options[0]!.slice(2));
    assert.ok(options[0]!.slice(2).length <= 40);
    return options.includes("Next") ? "Next" : "Back";
  } } }, "opencode-pi configuration (environment presence)", records);
  assert.equal(segments.join(""), records.join(""));
  assert.deepEqual(segments.slice(0, 2), ["Back", records[1]!.slice(0, 40)]);
  await showOpenCodePanelList({ ui: { select: async (title: string) => {
    assert.equal(title, `${"X".repeat(30)} (1/1)`);
    return undefined;
  } } }, "X".repeat(80), ["ok"]);
});

function panelOpenCodeCommand() {
  type PanelCommand = {
    handler: (args: string, ctx: unknown) => Promise<void>;
  };
  let command: PanelCommand | undefined;
  return {
    extension: {
      registerProvider() {},
      on() {},
      registerCommand(name: string, registered: unknown) {
        if (name === "opencode-pi") command = registered as PanelCommand;
      },
    } as unknown as ExtensionAPI,
    get command(): PanelCommand {
      if (!command) throw new Error("opencode-pi command was not registered");
      return command;
    },
  };
}

test("bare opencode-pi uses a cancellable read-only panel without discovery or CLI calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-pi-panel-"));
  const marker = join(dir, "cli-invoked");
  const binPath = join(dir, "opencode-panel.js");
  writeFileSync(
    binPath,
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "called");\nprocess.stdout.write("opencode v1.0.0");\n`,
    "utf8",
  );
  chmodSync(binPath, 0o755);
  const previousBin = process.env.OPENCODE_PI_BIN;
  const previousModels = process.env.OPENCODE_PI_MODELS;
  process.env.OPENCODE_PI_BIN = binPath;
  const modelIds = [
    "auto",
    "composer-2.5",
    "opencode/alice.smith",
    "Users/alice/project",
    "fake-model-key",
    "provider/fake-model-key/model",
    "fake-github-token",
    "my-secret-token",
    "bearer-abcdefghijklmnopqrstuvwxyz0123456789",
    "https://user:password@example.test/token",
    "user@example.test",
    "token_0123456789abcdef",
  ];
  const secretValues = [
    ...modelIds,
    binPath,
  ];
  process.env.OPENCODE_PI_MODELS = modelIds.join(",");

  try {
    const captured = panelOpenCodeCommand();
    await opencodePiExtension(captured.extension);
    const selections: { title: string; options: string[] }[] = [];
    const choices = ["Status (cached)", "Close"];
    await captured.command.handler("", {
      mode: "tui",
      hasUI: true,
      ui: {
        async select(title: string, options: string[]) {
          selections.push({ title, options });
          return title !== "opencode-pi (read-only)" && options.includes("Next") ? "Next" : choices.shift();
        },
        notify() {
          throw new Error("the read-only panel must not notify");
        },
      },
    });

    assert.ok(selections.length >= 4);
    assert.ok(selections[0]!.options.includes("Close"));
    assert.equal(existsSync(marker), false);
    const statusPanelText = JSON.stringify(selections);
    const detailText = selections.map(({ options }) => options[0]?.startsWith("• ") ? options[0].slice(2) : "").join("");
    assert.match(detailText, /Model discovery: configured\/skipped/);
    assert.match(statusPanelText, new RegExp(`Registered models: ${modelIds.length}`));
    for (const modelId of modelIds) assert.equal(statusPanelText.includes(modelId), false);
    for (const secret of secretValues) assert.equal(statusPanelText.includes(secret), false);

    const configSelections: { title: string; options: string[] }[] = [];
    const configChoices = ["Configuration (environment presence)", "Close"];
    await captured.command.handler("", {
      mode: "tui",
      hasUI: true,
      ui: {
        async select(title: string, options: string[]) {
          configSelections.push({ title, options });
          return title !== "opencode-pi (read-only)" && options.includes("Next") ? "Next" : configChoices.shift();
        },
      },
    });
    const configPanelText = JSON.stringify(configSelections);
    assert.match(configPanelText, /OPENCODE_PI_BIN: set/);
    assert.match(configPanelText, /OPENCODE_PI_MODELS: set/);
    for (const secret of secretValues) assert.equal(configPanelText.includes(secret), false);
  } finally {
    unregisterApiProviders("opencode-cli");
    restoreEnv("OPENCODE_PI_BIN", previousBin);
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode-pi panel hides configured model IDs, supports cancellation, and preserves non-TUI fallback", async () => {
  const previousBin = process.env.OPENCODE_PI_BIN;
  const previousModels = process.env.OPENCODE_PI_MODELS;
  process.env.OPENCODE_PI_BIN = "/tmp/opencode-panel-secret-bin";
  const modelIds = [
    "auto",
    "composer-2.5",
    "opencode/alice.smith",
    "Users/alice/project",
    "fake-model-key",
    "provider/fake-model-key/model",
    "fake-github-token",
    "my-secret-token",
    "bearer-abcdefghijklmnopqrstuvwxyz0123456789",
    "https://user:password@example.test/token",
    "user@example.test",
    "token_0123456789abcdef",
  ];
  process.env.OPENCODE_PI_MODELS = modelIds.join(",");

  try {
    const captured = panelOpenCodeCommand();
    await opencodePiExtension(captured.extension);

    let calls = 0;
    await captured.command.handler("", {
      mode: "tui",
      hasUI: true,
      ui: {
        async select() {
          calls += 1;
          return undefined;
        },
        notify() {
          throw new Error("cancelled panel must not notify");
        },
      },
    });
    assert.equal(calls, 1);

    const selections: { title: string; options: string[] }[] = [];
    const choices = ["Models (cached)", "Close"];
    await captured.command.handler("", {
      mode: "tui",
      hasUI: true,
      ui: {
        async select(title: string, options: string[]) {
          selections.push({ title, options });
          return title !== "opencode-pi (read-only)" && options.includes("Next") ? "Next" : choices.shift();
        },
      },
    });
    const panelText = JSON.stringify(selections);
    assert.match(panelText, new RegExp(`Registered models: ${modelIds.length}`));
    assert.match(selections.map(({ options }) => options[0]?.startsWith("• ") ? options[0].slice(2) : "").join(""), /IDs hidden to avoid exposing configured values/);
    for (const modelId of modelIds) assert.equal(panelText.includes(modelId), false);

    const explicitNotifications: string[] = [];
    let explicitSelectCalls = 0;
    await captured.command.handler("help", {
      mode: "tui",
      hasUI: true,
      ui: {
        async select() {
          explicitSelectCalls += 1;
          throw new Error("explicit subcommands must not open the panel");
        },
        notify(message: string) {
          explicitNotifications.push(message);
        },
      },
    });
    assert.equal(explicitSelectCalls, 0);
    assert.ok(explicitNotifications.some((message) => message.includes("Usage: /opencode-pi")));

    const notifications: string[] = [];
    calls = 0;
    for (const mode of ["tui", "print"]) {
      await captured.command.handler("", {
        mode,
        hasUI: false,
        ui: {
          async select() {
            calls += 1;
            throw new Error("a context without UI must not select");
          },
          notify(message: string) {
            notifications.push(message);
          },
        },
      });
    }
    assert.equal(calls, 0);
    assert.ok(notifications.length > 0);
  } finally {
    unregisterApiProviders("opencode-cli");
    restoreEnv("OPENCODE_PI_BIN", previousBin);
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
  }
});

test("opencode-pi keeps informational rows in detail and supports Back, another section, Close, and Escape", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  process.env.OPENCODE_PI_MODELS = "custom-panel-model";

  try {
    const captured = panelOpenCodeCommand();
    await opencodePiExtension(captured.extension);
    const selections: { title: string; options: string[] }[] = [];
    const topChoices = ["Status (cached)", "Configuration (environment presence)"];
    let statusDetailVisits = 0;

    await captured.command.handler("", {
      mode: "tui",
      hasUI: true,
      ui: {
        async select(title: string, options: string[]) {
          selections.push({ title, options });
          if (title === "opencode-pi (read-only)") return topChoices.shift();
          if (title.startsWith("OpenCode CLI status (cached) (")) {
            if (statusDetailVisits++ === 0) return options[0];
            return "Back";
          }
          if (title.startsWith("opencode-pi configuration (")) return "Close";
          throw new Error(`unexpected panel ${title}`);
        },
      },
    });

    assert.deepEqual(selections.map(({ title }) => title), [
      "opencode-pi (read-only)",
      "OpenCode CLI status (cached) (1/3)",
      "OpenCode CLI status (cached) (1/3)",
      "opencode-pi (read-only)",
      "opencode-pi configuration (1/2)",
    ]);
    assert.ok(selections[1]!.options.includes("Back"));
    assert.ok(selections[1]!.options.includes("Close"));
    assert.ok(selections[2]!.options.includes("Back"));
    assert.ok(selections[4]!.options.includes("Back"));
    assert.ok(selections[4]!.options.includes("Close"));

    const escapedSelections: { title: string; options: string[] }[] = [];
    await captured.command.handler("", {
      mode: "tui",
      hasUI: true,
      ui: {
        async select(title: string, options: string[]) {
          escapedSelections.push({ title, options });
          return title === "opencode-pi (read-only)" ? "Models (cached)" : undefined;
        },
      },
    });
    assert.deepEqual(escapedSelections.map(({ title }) => title), [
      "opencode-pi (read-only)",
      "OpenCode models (cached) (1/3)",
    ]);
    assert.ok(escapedSelections[1]!.options.includes("Back"));
    assert.ok(escapedSelections[1]!.options.includes("Close"));
  } finally {
    unregisterApiProviders("opencode-cli");
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
  }
});
