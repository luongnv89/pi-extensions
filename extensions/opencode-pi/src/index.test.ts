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
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEvents, runningOpenCodeServer, stopOpenCodeServer, withOpenCodeServer } from "./server.js";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeContext } from "@earendil-works/pi-ai";
import {
  getApiProvider,
  unregisterApiProviders,
} from "@earendil-works/pi-ai/compat";
import type {
  Api,
  SimpleStreamOptions,
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
  resolveTurnTimeoutMs,
  streamOpenCode,
  showOpenCodePanelList,
  trackedPiSessionCount,
  whenStartupChecked,
  writeBridgeConfig,
} from "./index.js";

// Keep the model cache out of the real Pi agent directory.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "opencode-pi-agent-"));

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

type FakeServerConfig = {
  /** Appends one JSON line per server request (except event streams). */
  capturePath?: string;
  /** Written when the fake server starts. */
  sentinelPath?: string;
  /** Returned by POST /session. */
  sessionId?: string;
  /** Server events sent after a prompt; `{ waitFor: path }` pauses until the file exists. */
  events?: unknown[];
  /** Send session.status idle after the events (default true). */
  idle?: boolean;
  /** Permission IDs whose reply answers 404, as if already settled. */
  settledPermissions?: string[];
};

const DEFAULT_TURN_EVENTS = [
  textPart("prt_hello", "hello"),
  stepFinish("stop", { total: 10, input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }),
];

/**
 * A fake `opencode` binary whose `serve` command speaks the subset of the
 * OpenCode server API the bridge uses. Each prompt replays the scripted
 * events with the session ID filled in.
 */
function fakeServer(config: FakeServerConfig = {}): string {
  return `const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const config = ${JSON.stringify({ ...config, events: config.events ?? DEFAULT_TURN_EVENTS })};
if (process.argv[2] === "session") process.exit(0);
if (process.argv[2] !== "serve") process.exit(1);
if (config.sentinelPath) fs.writeFileSync(config.sentinelPath, "ran");
const auth = "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_SERVER_PASSWORD).toString("base64");
const clients = new Set();
let created = 0;
const record = (entry) => { if (config.capturePath) fs.appendFileSync(config.capturePath, JSON.stringify(entry) + "\\n"); };
const send = (event) => { for (const res of clients) res.write("data: " + JSON.stringify(event) + "\\n\\n"); };
const wait = (file) => new Promise((resolve) => { const check = () => fs.existsSync(file) ? resolve() : setTimeout(check, 5); check(); });
const withSession = (event, sessionID) => {
  const copy = JSON.parse(JSON.stringify(event));
  copy.properties = copy.properties || {};
  if (copy.properties.part) copy.properties.part.sessionID = sessionID;
  else copy.properties.sessionID = sessionID;
  return copy;
};
http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", async () => {
    if (req.headers.authorization !== auth) { res.writeHead(401); res.end(); return; }
    const url = new URL(req.url, "http://fake");
    const directory = url.searchParams.get("directory");
    if (url.pathname === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      clients.add(res);
      res.on("close", () => clients.delete(res));
      res.write("data: " + JSON.stringify({ type: "server.connected", properties: {} }) + "\\n\\n");
      return;
    }
    const entry = { method: req.method, path: url.pathname, directory, body: body ? JSON.parse(body) : undefined };
    if (url.pathname === "/session") {
      created += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: config.sessionId || "ses-fake" }));
      return;
    }
    const prompt = url.pathname.match(/^\\/session\\/([^/]+)\\/prompt_async$/);
    if (!prompt) {
      record(entry);
      if ((config.settledPermissions || []).some((id) => url.pathname === "/permission/" + id + "/reply")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ _tag: "PermissionNotFoundError" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("true");
      return;
    }
    const sessionID = prompt[1];
    record({
      ...entry,
      sessionID,
      continued: created === 0,
      text: entry.body.parts.at(-1).text,
      tools: fs.readdirSync(path.join(directory, ".opencode", "tools")).sort(),
      agent: fs.readFileSync(path.join(directory, ".opencode", "agents", "pi-model.md"), "utf8"),
    });
    res.writeHead(204);
    res.end();
    for (const event of config.events) {
      if (event.waitFor) await wait(event.waitFor);
      else send(withSession(event, sessionID));
    }
    if (config.idle !== false) send(withSession({ type: "session.status", properties: { status: { type: "idle" } } }, sessionID));
  });
}).listen(0, "127.0.0.1", function () {
  console.log("opencode server listening on http://127.0.0.1:" + this.address().port);
});
`;
}

function textPart(id: string, text: string, type = "text") {
  return { type: "message.part.updated", properties: { part: { id, type, text, time: { start: 1, end: 2 } } } };
}

function partStart(id: string, type = "text") {
  return { type: "message.part.updated", properties: { part: { id, type, text: "", time: { start: 1 } } } };
}

function partDelta(partID: string, delta: string) {
  return { type: "message.part.delta", properties: { partID, field: "text", delta } };
}

function toolPart(tool: string, callID: string, status: string, input: unknown) {
  return { type: "message.part.updated", properties: { part: { id: `prt_${callID}`, type: "tool", tool, callID, state: { status, input } } } };
}

function stepFinish(reason: string, tokens?: unknown) {
  return { type: "message.part.updated", properties: { part: { id: `prt_finish_${reason}`, type: "step-finish", reason, tokens } } };
}

function sessionError(message: string) {
  return { type: "session.error", properties: { error: { name: "UnknownError", data: { message } } } };
}

type Captured = {
  method: string;
  path: string;
  directory: string;
  body?: any;
  sessionID?: string;
  continued?: boolean;
  text?: string;
  tools?: string[];
  agent?: string;
};

function readCaptured(capturePath: string): Captured[] {
  if (!existsSync(capturePath)) return [];
  return readFileSync(capturePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Only the prompt requests, one per turn. */
function readInvocations(capturePath: string): Captured[] {
  return readCaptured(capturePath).filter((entry) => entry.path.endsWith("/prompt_async"));
}

async function collectStreamEvents(
  script: string,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<AssistantMessageEvent[]> {
  return withFakeOpenCode(script, async () => {
    const events: AssistantMessageEvent[] = [];
    for await (const event of streamOpenCode(fakeModel(), context, options)) {
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
    stopOpenCodeServer();
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
      fakeServer({ sentinelPath }),
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
    // A title request would share the free tier's rate limit with the turn.
    assert.equal(readFileSync(join(dir, ".opencode", "agents", "title.md"), "utf8"), "---\ndisable: true\n---\n");

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

test("streamOpenCode turns finished Pi tool parts into Pi tool calls", async () => {
  const captureDir = mkdtempSync(join(tmpdir(), "opencode-pi-capture-"));
  const capturePath = join(captureDir, "requests.jsonl");
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
  try {
    const events = await collectStreamEvents(
      fakeServer({
        capturePath,
        events: [
          textPart("prt_text", "Reading it."),
          toolPart("read", "call_1", "pending", {}),
          { type: "permission.asked", properties: { id: "per_1", permission: "pi_tool" } },
          toolPart("read", "call_1", "error", { path: "README.md", limit: null }),
          // A call to an unavailable stub already got its answer inside OpenCode.
          toolPart("apply_patch", "call_2", "completed", {}),
          stepFinish("tool-calls"),
        ],
      }),
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
    // The bridge rejects the pi_tool ask so OpenCode never runs the tool.
    const reply = readCaptured(capturePath).find((entry) => entry.path === "/permission/per_1/reply");
    assert.deepEqual(reply?.body, { reply: "reject" });
  } finally {
    rmSync(captureDir, { recursive: true, force: true });
  }
});

test("streamOpenCode hands parallel Pi tool calls over when one rejection settles both asks", async () => {
  const context: Context = { messages: [], tools: fakeContext(["read"]).tools };
  const events = await collectStreamEvents(
    fakeServer({
      // OpenCode drops every pending ask when one is rejected.
      settledPermissions: ["per_2"],
      events: [
        { type: "permission.asked", properties: { id: "per_1", permission: "pi_tool" } },
        { type: "permission.asked", properties: { id: "per_2", permission: "pi_tool" } },
        toolPart("read", "call_a", "error", { path: "a.txt" }),
        toolPart("read", "call_b", "error", { path: "b.txt" }),
        stepFinish("tool-calls"),
      ],
    }),
    context,
  );
  const done = events.at(-1);
  if (done?.type !== "done") return assert.fail(`expected done, got ${JSON.stringify(done)}`);
  assert.deepEqual(
    done.message.content.map((block) => (block.type === "toolCall" ? block.arguments : block.type)),
    [{ path: "a.txt" }, { path: "b.txt" }],
  );
});

test("streamOpenCode streams text deltas before the turn finishes", async () => {
  const gateDir = mkdtempSync(join(tmpdir(), "opencode-pi-gate-"));
  const gate = join(gateDir, "first-delta-seen");
  try {
    const events = await withFakeOpenCode(
      fakeServer({
        events: [
          partStart("prt_think", "reasoning"),
          partDelta("prt_think", "Plan"),
          textPart("prt_think", "Plan.", "reasoning"),
          partStart("prt_text"),
          partDelta("prt_text", "Hel"),
          // The server holds the rest of the turn until Pi has seen a delta.
          { waitFor: gate },
          partDelta("prt_text", "lo"),
          textPart("prt_text", "Hello!"),
          stepFinish("stop"),
        ],
      }),
      async () => {
        const seen: AssistantMessageEvent[] = [];
        for await (const event of streamOpenCode(fakeModel(), fakeContext())) {
          seen.push(event);
          if (event.type === "text_delta") writeFileSync(gate, "");
        }
        return seen;
      },
    );

    assert.deepEqual(
      events.map((event) => (event.type.endsWith("_delta") ? `${event.type}:${(event as { delta: string }).delta}` : event.type)),
      [
        "start",
        "thinking_start", "thinking_delta:Plan", "thinking_delta:.", "thinking_end",
        "text_start", "text_delta:Hel", "text_delta:lo", "text_delta:!", "text_end",
        "done",
      ],
    );
    const done = events.at(-1);
    if (done?.type !== "done") return assert.fail("expected done");
    assert.deepEqual(done.message.content, [
      { type: "thinking", thinking: "Plan." },
      { type: "text", text: "Hello!" },
    ]);
  } finally {
    rmSync(gateDir, { recursive: true, force: true });
  }
});

test("streamOpenCode diagnoses empty provider output", async () => {
  const message = await withFakeOpenCode(fakeServer({ events: [] }), () =>
    streamOpenCode(fakeModel(), fakeContext()).result(),
  );

  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /empty assistant response \(no text\)/);
  assert.match(message.errorMessage ?? "", /Retry the request or select another OpenCode model/);
});

test("streamOpenCode diagnoses empty output with whitespace-only text", async () => {
  const message = await withFakeOpenCode(
    fakeServer({ events: [textPart("prt_ws", "   \n\n   ")] }),
    () => streamOpenCode(fakeModel(), fakeContext(["read"])).result(),
  );

  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /empty assistant response \(whitespace-only text, length=8\)/);
});

test("streamOpenCode never starts opencode when the signal aborts before setup", async () => {
  const sentinelDir = mkdtempSync(join(tmpdir(), "opencode-pi-sentinel-"));
  const sentinelPath = join(sentinelDir, "ran.marker");

  try {
    const message = await withFakeOpenCode(
      fakeServer({ sentinelPath }),
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

test("streamOpenCode starts opencode and returns its output when not aborted", async () => {
  const sentinelDir = mkdtempSync(join(tmpdir(), "opencode-pi-sentinel-"));
  const sentinelPath = join(sentinelDir, "ran.marker");

  try {
    const message = await withFakeOpenCode(
      fakeServer({ sentinelPath }),
      () => streamOpenCode(fakeModel(), fakeContext()).result(),
    );

    assert.equal(existsSync(sentinelPath), true);
    assert.equal(message.stopReason, "stop");
    assert.deepEqual(message.content, [{ type: "text", text: "hello" }]);
    assert.equal(message.usage.totalTokens, 10);
  } finally {
    rmSync(sentinelDir, { recursive: true, force: true });
  }
});

test("streamOpenCode never starts opencode when the signal aborts after image setup", async () => {
  const sentinelDir = mkdtempSync(join(tmpdir(), "opencode-pi-sentinel-"));
  const sentinelPath = join(sentinelDir, "ran.marker");

  try {
    const message = await withFakeOpenCode(
      fakeServer({ sentinelPath }),
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

test("streamOpenCode succeeds with reasoning-only output", async () => {
  const message = await withFakeOpenCode(
    fakeServer({ events: [textPart("prt_r", "thinking it through", "reasoning")] }),
    () => streamOpenCode(fakeModel(), fakeContext()).result(),
  );

  assert.equal(message.stopReason, "stop");
  assert.equal(message.errorMessage, undefined);
  assert.deepEqual(message.content, [{ type: "thinking", thinking: "thinking it through" }]);
});

test("streamOpenCode returns the expected error outcome when opencode times out", async () => {
  const message = await withFakeOpenCode(
    fakeServer({ events: [], idle: false }),
    () =>
      streamOpenCode(fakeModel(), fakeContext(), {
        timeoutMs: 30,
      }).result(),
  );

  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "opencode timed out after 30ms");
});

test("streamOpenCode aborts the OpenCode session when Pi aborts mid-turn", async () => {
  const captureDir = mkdtempSync(join(tmpdir(), "opencode-pi-capture-"));
  const capturePath = join(captureDir, "requests.jsonl");
  const controller = new AbortController();
  try {
    const events = await withFakeOpenCode(
      fakeServer({
        capturePath,
        sessionId: "ses-abort",
        events: [partStart("prt_text"), partDelta("prt_text", "partial")],
        idle: false,
      }),
      async () => {
        const seen: AssistantMessageEvent[] = [];
        for await (const event of streamOpenCode(fakeModel(), fakeContext(), { signal: controller.signal })) {
          seen.push(event);
          if (event.type === "text_delta") controller.abort();
        }
        return seen;
      },
    );

    const error = events.at(-1);
    if (error?.type !== "error") return assert.fail("expected error");
    assert.equal(error.reason, "aborted");
    assert.equal(error.error.errorMessage, "Request was aborted");
    // The streamed text block is closed and kept.
    assert.deepEqual(error.error.content, [{ type: "text", text: "partial" }]);
    assert.ok(events.some((event) => event.type === "text_end"));
    assert.ok(readCaptured(capturePath).some((entry) => entry.path === "/session/ses-abort/abort"));
  } finally {
    rmSync(captureDir, { recursive: true, force: true });
  }
});

test("streamOpenCode sends the agent, model, reasoning variant, and images", async () => {
  const captureDir = mkdtempSync(join(tmpdir(), "opencode-pi-capture-"));
  const capturePath = join(captureDir, "requests.jsonl");
  const model: Model<Api> = {
    ...fakeModel(),
    reasoning: true,
    input: ["text", "image"],
    thinkingLevelMap: { high: "max" },
  };

  try {
    const message = await withFakeOpenCode(
      fakeServer({ capturePath }),
      () =>
        streamOpenCode(
          model,
          imageContext("image/png", Buffer.from("image bytes").toString("base64")),
          { reasoning: "high" },
        ).result(),
    );

    assert.equal(message.stopReason, "stop");
    const invocation = readInvocations(capturePath)[0];
    assert.equal(invocation?.body.agent, "pi-model");
    assert.deepEqual(invocation?.body.model, { providerID: "opencode", modelID: "fake-free" });
    assert.equal(invocation?.body.variant, "max");
    assert.deepEqual(invocation?.body.parts[0], {
      type: "file",
      mime: "image/png",
      filename: "image-001.png",
      url: `data:image/png;base64,${Buffer.from("image bytes").toString("base64")}`,
    });
    assert.match(invocation?.agent ?? "", /mode: primary/);
    assert.match(invocation?.agent ?? "", /\n  "read": allow\n/);
    assert.match(invocation?.directory ?? "", /opencode-pi-/);
  } finally {
    rmSync(captureDir, { recursive: true, force: true });
  }
});

test("streamOpenCode omits the variant when the model has none for the level", async () => {
  const captureDir = mkdtempSync(join(tmpdir(), "opencode-pi-capture-"));
  const capturePath = join(captureDir, "requests.jsonl");
  try {
    const message = await withFakeOpenCode(
      fakeServer({ capturePath }),
      () => streamOpenCode(fakeModel(), fakeContext(), { reasoning: "low" }).result(),
    );
    assert.equal(message.stopReason, "stop");
    assert.equal("variant" in (readInvocations(capturePath)[0]?.body ?? {}), false);
  } finally {
    rmSync(captureDir, { recursive: true, force: true });
  }
});

test("streamOpenCode runs OpenCode v2 turns through opencode run", async () => {
  const captureDir = mkdtempSync(join(tmpdir(), "opencode-pi-v2-capture-"));
  const capturePath = join(captureDir, "invocation.json");
  const model: Model<Api> = {
    ...fakeModel(),
    reasoning: true,
    input: ["text", "image"],
    thinkingLevelMap: { low: "low" },
  };
  const context = imageContext("image/png", Buffer.from("image bytes").toString("base64"));
  context.tools = fakeContext(["read"]).tools;
  try {
    const events = await withFakeOpenCode(
      `const fs = require("node:fs");
if (process.argv[2] === "session") process.exit(0);
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const image = args[args.indexOf("--file") + 1];
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
    args, stdin, cwd: process.cwd(), pwd: fs.realpathSync(process.env.PWD),
    imageHex: fs.readFileSync(image).toString("hex"),
    agent: fs.readFileSync(".opencode/agents/pi-model.md", "utf8"),
  }));
  const emit = (type, part) => process.stdout.write(JSON.stringify({ type, sessionID: "ses-v2", part }) + "\\n");
  emit("reasoning", { id: "prt_r", type: "reasoning", text: "Plan.", time: { start: 1, end: 2 } });
  emit("text", { id: "prt_t", type: "text", text: "Reading it.", time: { start: 2, end: 3 } });
  emit("tool_use", { partID: "prt_tool", type: "tool", id: "call_v2", tool: "read", state: { status: "error", input: { path: "a.txt" } } });
  emit("step_finish", { id: "prt_f", type: "step-finish", reason: "tool-calls", tokens: { total: 7, input: 4, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } });
});`,
      async () => {
        const seen: AssistantMessageEvent[] = [];
        for await (const event of streamOpenCode(model, context, { reasoning: "low" })) seen.push(event);
        return seen;
      },
      "opencode v2.0.16",
    );

    const done = events.at(-1);
    if (done?.type !== "done") return assert.fail(`expected done, got ${JSON.stringify(done)}`);
    assert.equal(done.reason, "toolUse");
    assert.deepEqual(done.message.content, [
      { type: "thinking", thinking: "Plan." },
      { type: "text", text: "Reading it." },
      { type: "toolCall", id: "call_v2", name: "read", arguments: { path: "a.txt" } },
    ]);
    assert.equal(done.message.usage.totalTokens, 7);
    const invocation = JSON.parse(readFileSync(capturePath, "utf8")) as {
      args: string[];
      stdin: string;
      cwd: string;
      pwd: string;
      imageHex: string;
      agent: string;
    };
    assert.deepEqual(invocation.args.slice(0, -2), [
      "run", "--standalone", "-m", "opencode/fake-free#low",
      "--agent", "pi-model", "--format", "json", "--thinking",
    ]);
    assert.equal(invocation.args.at(-2), "--file");
    assert.equal(invocation.imageHex, Buffer.from("image bytes").toString("hex"));
    assert.match(invocation.stdin, /Conversation transcript/);
    assert.match(invocation.agent, /mode: primary/);
    // v2 would run its own tools under any allow rule.
    assert.match(invocation.agent, /permission:\n  "\*": ask\n---/);
    assert.match(invocation.cwd, /opencode-pi-/);
    // v2 reads the project directory from PWD, not the process cwd.
    assert.equal(invocation.pwd, invocation.cwd);
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
  emit("text", { id: "prt_t", type: "text", text: "a.txt does not exist.", time: { start: 1, end: 2 } });
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

test("streamOpenCode never starts an OpenCode v2 run after the turn already timed out", async () => {
  const sentinelDir = mkdtempSync(join(tmpdir(), "opencode-pi-sentinel-"));
  const sentinelPath = join(sentinelDir, "ran.marker");
  try {
    const message = await withFakeOpenCode(
      `if (process.argv[2] === "run") require("node:fs").writeFileSync(${JSON.stringify(sentinelPath)}, "ran");
process.exit(0);`,
      // A 1ms budget runs out during setup, before the run would start.
      () => streamOpenCode(fakeModel(), fakeContext(["read"]), { timeoutMs: 1 }).result(),
      "opencode v2.0.16",
    );
    assert.equal(message.stopReason, "error");
    assert.equal(message.errorMessage, "opencode timed out after 1ms");
    assert.equal(existsSync(sentinelPath), false);
  } finally {
    rmSync(sentinelDir, { recursive: true, force: true });
  }
});

test("parseEvents keeps CRLF event separators split across chunks", async () => {
  const encoder = new TextEncoder();
  const text = 'data: {"type":"a"}\r\n\r\ndata: {"type":"b"}\r\n\r\n';
  // Split inside the first separator, between its \r and \n.
  const cut = text.indexOf("\r\n\r\n") + 3;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text.slice(0, cut)));
      controller.enqueue(encoder.encode(text.slice(cut)));
      controller.close();
    },
  });
  const types: string[] = [];
  for await (const event of parseEvents(body)) types.push(event.type);
  assert.deepEqual(types, ["a", "b"]);
});

test("the shared server stops parsing its output once it is ready", async () => {
  await withFakeOpenCode(
    `if (process.argv[2] !== "serve") process.exit(1);
require("node:http").createServer(() => undefined).listen(0, "127.0.0.1", function () {
  console.log("opencode server listening on http://127.0.0.1:" + this.address().port);
  let n = 0;
  const timer = setInterval(() => { console.log("request log " + n); if (++n === 30) clearInterval(timer); }, 2);
});`,
    async () => {
      const server = await withOpenCodeServer(process.env.OPENCODE_PI_BIN!, process.env, async (server) => server);
      await new Promise((resolve) => setTimeout(resolve, 300));
      // One exit listener for the running server, plus Node's own.
      assert.ok(server.child.listenerCount("exit") <= 2, `exit listeners: ${server.child.listenerCount("exit")}`);
      assert.equal(runningOpenCodeServer(), server);
    },
  );
});

test("streamOpenCode reports OpenCode v2 run failures", async () => {
  const message = await withFakeOpenCode(
    `if (process.argv[2] === "session") process.exit(0);
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "error", sessionID: "ses-v2", error: { message: "model not found" } }) + "\\n");
  process.exit(1);
});`,
    () => streamOpenCode(fakeModel(), fakeContext()).result(),
    "opencode v2.0.16",
  );
  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "model not found");
});

test("streamOpenCode refuses unknown CLI versions rather than guessing", async () => {
  const message = await withFakeOpenCode(
    fakeServer(),
    () => streamOpenCode(fakeModel(), fakeContext()).result(),
    "not a version",
  );
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /Cannot determine OpenCode CLI version/);
});

test("streamOpenCode reports a server that fails to start", async () => {
  const message = await withFakeOpenCode(
    `if (process.argv[2] === "serve") { console.error("port in use"); process.exit(3); }`,
    () => streamOpenCode(fakeModel(), fakeContext()).result(),
  );
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /opencode serve exited with code 3 before it was ready: port in use/);
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
        } as unknown as ExtensionAPI).then(whenStartupChecked),
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
      await whenStartupChecked();
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
      async () => {
        await opencodePiExtension(recorder.extension);
        await whenStartupChecked();
      },
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

test("the extension registers cached models without waiting on the CLI", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  delete process.env.OPENCODE_PI_MODELS;
  let registered: string[] = [];
  try {
    await withFakeOpenCode(
      // A CLI that takes 2s to answer anything.
      `setTimeout(() => process.stdout.write("opencode/fresh-free\\n"), 2000);`,
      async () => {
        const cache = join(process.env.PI_CODING_AGENT_DIR!, "cache", "opencode-pi-models.json");
        mkdirSync(dirname(cache), { recursive: true });
        writeFileSync(cache, JSON.stringify({ bin: process.env.OPENCODE_PI_BIN, models: [{ id: "opencode/cached-free", name: "Cached", reasoning: false, image: false, contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] }));
        const extension = {
          registerProvider(_id: string, config: { models: { id: string }[] }) {
            registered = config.models.map((model) => model.id);
          },
          on() {},
          registerCommand() {},
        } as unknown as ExtensionAPI;
        const started = Date.now();
        await opencodePiExtension(extension);
        assert.ok(Date.now() - started < 1000, `startup took ${Date.now() - started}ms`);
        assert.deepEqual(registered, ["opencode/cached-free"]);
        // Background discovery replaces them once the CLI answers.
        await whenStartupChecked();
        assert.deepEqual(registered, ["opencode/fresh-free"]);
      },
    );
  } finally {
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
  }
});

test("discoverModels skips the v2 API on a v1 CLI and keeps errors to one line", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  delete process.env.OPENCODE_PI_MODELS;
  const logDir = mkdtempSync(join(tmpdir(), "opencode-pi-argv-"));
  const log = join(logDir, "argv.log");
  try {
    const { error } = await withFakeOpenCode(
      `require("node:fs").appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");
process.stderr.write("\\x1b[91mError: \\x1b[0mUnexpected error\\n\\nno such column: project_id\\n");
process.exit(1);`,
      () => discoverModels(),
      "1.19.3",
    );
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["models opencode --verbose", "models"]);
    assert.equal(
      error,
      "opencode models opencode --verbose: Error: Unexpected error no such column: project_id | opencode models: Error: Unexpected error no such column: project_id",
    );
  } finally {
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
    rmSync(logDir, { recursive: true, force: true });
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

test("resolveTurnTimeoutMs honors Pi timeouts and bounds unbounded turns", () => {
  assert.equal(resolveTurnTimeoutMs(30), 30);
  assert.equal(resolveTurnTimeoutMs(600_000), 600_000);
  assert.equal(resolveTurnTimeoutMs(undefined), 180_000);
  assert.equal(resolveTurnTimeoutMs(0), 180_000);
  assert.equal(resolveTurnTimeoutMs(-5), 180_000);
  assert.equal(resolveTurnTimeoutMs(Number.NaN), 180_000);
  assert.equal(resolveTurnTimeoutMs(Number.POSITIVE_INFINITY), 180_000);
});

function countingSignal(): { signal: AbortSignal; counts: { added: number; removed: number } } {
  const counts = { added: 0, removed: 0 };
  const signal = {
    aborted: false,
    addEventListener() {
      counts.added += 1;
    },
    removeEventListener() {
      counts.removed += 1;
    },
  } as unknown as AbortSignal;
  return { signal, counts };
}

test("streamOpenCode detaches the abort listener on the error path", async () => {
  const { signal, counts } = countingSignal();
  const message = await withFakeOpenCode(
    fakeServer({ events: [sessionError("boom")] }),
    () =>
      streamOpenCode(fakeModel(), fakeContext(["read"]), { signal }).result(),
  );

  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "boom");
  assert.deepEqual(counts, { added: 1, removed: 1 });
});

test("streamOpenCode detaches the abort listener on the timeout path", async () => {
  const { signal, counts } = countingSignal();
  const message = await withFakeOpenCode(
    fakeServer({ events: [], idle: false }),
    () =>
      streamOpenCode(fakeModel(), fakeContext(), {
        signal,
        timeoutMs: 30,
      }).result(),
  );

  assert.equal(message.stopReason, "error");
  assert.deepEqual(counts, { added: 1, removed: 1 });
});

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
  const capturePath = join(captureDir, "requests.jsonl");
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
      fakeServer({ capturePath, sessionId: "ses-system-1" }),
      () => streamOpenCode(fakeModel(), context).result(),
    );
    assert.equal(message.stopReason, "stop");
    const invocation = readInvocations(capturePath)[0];
    const text = invocation?.text ?? "";
    assert.match(text, /BASE PROMPT/);
    assert.match(text, /LATER INSTRUCTION/);
    assert.ok(invocation?.tools?.includes("read.js"));
    assert.ok(invocation?.tools?.includes("bash.js"));
    assert.match(text, /USER:\nfirst question[\s\S]*USER:\nsecond question/);
    assert.equal(text.includes("SYSTEM:"), false);
  } finally {
    rmSync(captureDir, { recursive: true, force: true });
  }
});

test("streamOpenCode reuses the session and sends only the transcript delta", async () => {
  const captureDir = mkdtempSync(join(tmpdir(), "opencode-pi-capture-"));
  const capturePath = join(captureDir, "requests.jsonl");
  const piSessionId = `pi-reuse-${Date.now()}`;
  try {
    const first = await withFakeOpenCode(
      fakeServer({ capturePath, sessionId: "ses-reuse-1" }),
      () =>
        streamOpenCode(fakeModel(), userContext(["first question"]), {
          sessionId: piSessionId,
        }).result(),
    );
    assert.equal(first.stopReason, "stop");

    const second = await withFakeOpenCode(
      fakeServer({ capturePath, sessionId: "ses-unused" }),
      () =>
        streamOpenCode(fakeModel(), conversationContext(), {
          sessionId: piSessionId,
        }).result(),
    );
    assert.equal(second.stopReason, "stop");

    const invocations = readInvocations(capturePath);
    assert.equal(invocations.length, 2);
    // First turn starts a fresh session with the full transcript.
    assert.equal(invocations[0]?.continued, false);
    assert.match(invocations[0]?.text ?? "", /first question/);
    // Continuation reuses the session and directory and sends the delta.
    assert.equal(invocations[1]?.continued, true);
    assert.equal(invocations[1]?.sessionID, "ses-reuse-1");
    assert.match(invocations[1]?.text ?? "", /second question/);
    assert.equal((invocations[1]?.text ?? "").includes("first question"), false);
    // The previous reply is already in the OpenCode session.
    assert.equal((invocations[1]?.text ?? "").includes("hello"), false);
    assert.equal(invocations[1]?.directory, invocations[0]?.directory);
    assert.equal(trackedPiSessionCount() >= 1, true);
  } finally {
    await cleanupPiSessionState(piSessionId);
    rmSync(captureDir, { recursive: true, force: true });
  }
});

test("streamOpenCode starts fresh after an error drops the session", async () => {
  const captureDir = mkdtempSync(join(tmpdir(), "opencode-pi-capture-"));
  const capturePath = join(captureDir, "requests.jsonl");
  const piSessionId = `pi-drop-${Date.now()}`;
  try {
    const first = await withFakeOpenCode(
      fakeServer({ capturePath, sessionId: "ses-drop-1" }),
      () =>
        streamOpenCode(fakeModel(), userContext(["first question"]), {
          sessionId: piSessionId,
        }).result(),
    );
    assert.equal(first.stopReason, "stop");

    // A failed turn (OpenCode session error) drops the recorded session.
    const failed = await withFakeOpenCode(
      fakeServer({ capturePath, events: [sessionError("boom")] }),
      () =>
        streamOpenCode(fakeModel(), userContext(["boom"]), {
          sessionId: piSessionId,
        }).result(),
    );
    assert.equal(failed.stopReason, "error");

    const recovered = await withFakeOpenCode(
      fakeServer({ capturePath, sessionId: "ses-drop-2" }),
      () =>
        streamOpenCode(fakeModel(), userContext(["third question"]), {
          sessionId: piSessionId,
        }).result(),
    );
    assert.equal(recovered.stopReason, "stop");

    const invocations = readInvocations(capturePath);
    assert.equal(invocations.length, 3);
    // The recovery turn starts a fresh full-transcript session.
    assert.equal(invocations[2]?.continued, false);
    assert.equal(invocations[2]?.sessionID, "ses-drop-2");
    assert.match(invocations[2]?.text ?? "", /Conversation transcript/);
  } finally {
    await cleanupPiSessionState(piSessionId);
    rmSync(captureDir, { recursive: true, force: true });
  }
});

test("streamOpenCode restarts the session and reloads the config when tools change", async () => {
  const captureDir = mkdtempSync(join(tmpdir(), "opencode-pi-capture-"));
  const capturePath = join(captureDir, "requests.jsonl");
  const piSessionId = `pi-tools-${Date.now()}`;
  try {
    const first = await withFakeOpenCode(
      fakeServer({ capturePath, sessionId: "ses-tools-1" }),
      async () => {
        const message = await streamOpenCode(fakeModel(), userContext(["q1"], ["read"]), {
          sessionId: piSessionId,
        }).result();
        assert.equal(message.stopReason, "stop");
        // Same server, new tool list: the stale instance must be reloaded.
        return streamOpenCode(fakeModel(), userContext(["q1", "q2"], ["read", "bash"]), {
          sessionId: piSessionId,
        }).result();
      },
    );
    assert.equal(first.stopReason, "stop");

    const requests = readCaptured(capturePath);
    const invocations = readInvocations(capturePath);
    assert.equal(invocations.length, 2);
    // A changed tool list restarts with the full transcript, not a delta.
    assert.notEqual(invocations[1]?.sessionID, undefined);
    assert.match(invocations[1]?.text ?? "", /Conversation transcript[\s\S]*q1/);
    assert.ok(invocations[0]?.tools?.includes("read.js"));
    assert.equal(invocations[0]?.tools?.includes("bash.js"), false);
    assert.ok(invocations[1]?.tools?.includes("bash.js"));
    const dispose = requests.findIndex((entry) => entry.path === "/instance/dispose");
    const prompts = requests.flatMap((entry, index) => (entry.path.endsWith("/prompt_async") ? [index] : []));
    assert.ok(prompts[0]! < dispose && dispose < prompts[1]!);
  } finally {
    await cleanupPiSessionState(piSessionId);
    rmSync(captureDir, { recursive: true, force: true });
  }
});

test("streamOpenCode runs isolated fresh sessions without a Pi session ID", async () => {
  const captureDir = mkdtempSync(join(tmpdir(), "opencode-pi-capture-"));
  const capturePath = join(captureDir, "requests.jsonl");
  try {
    await withFakeOpenCode(fakeServer({ capturePath, sessionId: "ses-once" }), async () => {
      for (const question of ["q1", "q2"]) {
        const message = await streamOpenCode(fakeModel(), userContext([question])).result();
        assert.equal(message.stopReason, "stop");
      }
    });
    const requests = readCaptured(capturePath);
    const invocations = readInvocations(capturePath);
    assert.equal(invocations.length, 2);
    for (const invocation of invocations) {
      assert.equal(invocation.continued, false);
      assert.match(invocation.text ?? "", /Conversation transcript/);
      // Each one-shot directory is unloaded and deleted after its turn.
      assert.ok(requests.some((entry) => entry.path === "/instance/dispose" && entry.directory === invocation.directory));
      assert.equal(existsSync(invocation.directory), false);
    }
    assert.notEqual(invocations[0]?.directory, invocations[1]?.directory);
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
      fakeServer({ capturePath, sessionId: "ses-teardown-1" }),
      () =>
        streamOpenCode(fakeModel(), userContext(["hello"]), {
          sessionId: piSessionId,
        }).result(),
    );
    before = trackedPiSessionCount();
    assert.equal(before >= 1, true);
    const dir = readInvocations(capturePath)[0]?.directory ?? "";
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
