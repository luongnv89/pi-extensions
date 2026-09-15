import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildCursorArgs,
  buildPrompt,
  configuredModels,
  createCursorStreamAccumulator,
  formatCursorToolStarted,
  formatUsageLines,
  parseAboutText,
  parseCursorStreamLine,
  parseModelsList,
  parseToolCalls,
  processCursorStreamEvent,
  PROVIDER_ID,
  resolveCursorModeFromContext,
  resolveCursorModeFromText,
} from "../dist/index.js";

describe("cursor-pi helpers", () => {
  it("registers Cursor aliases by default", () => {
    assert.equal(PROVIDER_ID, "cursor-cli");
    const ids = configuredModels(undefined).map((model) => model.id);
    assert.ok(ids.includes("auto"));
    assert.ok(ids.includes("composer-2.5"));
  });

  it("honors CURSOR_PI_MODELS overrides and dedupes", () => {
    const models = configuredModels("auto, composer-2.5,auto gpt-5.3-codex-high");
    assert.deepEqual(
      models.map((model) => model.id),
      ["auto", "composer-2.5", "gpt-5.3-codex-high"],
    );
    assert.equal(models[2].name, "Codex 5.3 High");
  });

  it("defaults to agent mode args", () => {
    assert.equal(resolveCursorModeFromText("fix the bug in auth"), "agent");
    assert.deepEqual(buildCursorArgs("auto"), [
      "-p",
      "--model",
      "auto",
      "--trust",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "-f",
    ]);
  });

  it("infers plan mode from plan or план in the user message", () => {
    assert.equal(resolveCursorModeFromText("/plan refactor auth"), "plan");
    assert.equal(resolveCursorModeFromText("составь план миграции"), "plan");
    assert.equal(resolveCursorModeFromText("use plan mode for this"), "plan");
  });

  it("infers ask mode only when explicitly requested", () => {
    assert.equal(resolveCursorModeFromText("ask mode: what does this function do?"), "ask");
    assert.equal(resolveCursorModeFromText("/ask explain auth flow"), "ask");
    assert.equal(resolveCursorModeFromText("I want to ask you about auth"), "agent");
  });

  it("resolves mode from Pi context messages", () => {
    assert.equal(
      resolveCursorModeFromContext({
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: [{ type: "text", text: "hi" }] },
          { role: "user", content: "режим план для рефакторинга" },
        ],
      }),
      "plan",
    );
  });

  it("builds ask and plan mode args", () => {
    assert.deepEqual(buildCursorArgs("auto", "ask"), [
      "-p",
      "--model",
      "auto",
      "--trust",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--mode",
      "ask",
    ]);
    assert.deepEqual(buildCursorArgs("auto", "plan"), [
      "-p",
      "--model",
      "auto",
      "--trust",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--mode",
      "plan",
    ]);
  });

  it("parses cursor stream-json lines and tool progress", () => {
    const started = parseCursorStreamLine(
      '{"type":"tool_call","subtype":"started","tool_call":{"shellToolCall":{"args":{"command":"rtk ls","description":"list"}}}}',
    );
    assert.ok(started);
    assert.match(formatCursorToolStarted(started), /rtk ls/);

    const state = createCursorStreamAccumulator();
    const deltas = [];
    processCursorStreamEvent(
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Hi" }] } },
      state,
      { onTextDelta: (delta) => deltas.push(delta) },
    );
    assert.deepEqual(deltas, ["Hi"]);
    processCursorStreamEvent({ type: "result", result: "Hi" }, state, {});
    assert.equal(state.finalResult, "Hi");
  });

  it("replays a captured cursor-agent stream fixture", () => {
    const fixture = readFileSync(new URL("./fixtures/cursor-stream.jsonl", import.meta.url), "utf8");
    const state = createCursorStreamAccumulator();
    const text = [];
    const tools = [];
    for (const line of fixture.split("\n")) {
      const event = parseCursorStreamLine(line);
      if (!event) continue;
      processCursorStreamEvent(event, state, {
        onTextDelta: (delta) => text.push(delta),
        onToolStart: (line) => tools.push(line),
      });
    }
    assert.ok(text.join("").includes("DONE"));
    assert.ok(tools.some((line) => line.includes("rtk ls")));
    assert.match(state.finalResult ?? "", /DONE/);
  });

  it("parses `cursor-agent models` output", () => {
    const output = [
      "Available models",
      "",
      "auto - Auto (current, default)",
      "gpt-5.3-codex-high - Codex 5.3 High",
      "cursor-grok-4.5-high-fast - Cursor Grok 4.5 Fast",
    ].join("\n");
    const models = parseModelsList(output);
    assert.deepEqual(models, [
      { id: "auto", name: "Auto (current, default)" },
      { id: "gpt-5.3-codex-high", name: "Codex 5.3 High" },
      { id: "cursor-grok-4.5-high-fast", name: "Cursor Grok 4.5 Fast" },
    ]);
  });

  it("returns no models for garbage output", () => {
    assert.deepEqual(parseModelsList("not a models list\nerror: boom"), []);
  });

  it("parses cursor-agent about text output", () => {
    const output = [
      "About Cursor CLI",
      "",
      "CLI Version         2026.08.11-e8db854",
      "Model               Composer 2.5",
      "Subscription Tier   Pro+",
      "User Email          user@example.com",
    ].join("\n");
    const about = parseAboutText(output);
    assert.equal(about.cliVersion, "2026.08.11-e8db854");
    assert.equal(about.subscriptionTier, "Pro+");
    assert.equal(about.userEmail, "user@example.com");
  });

  it("formats usage lines from about info", () => {
    const lines = formatUsageLines({
      subscriptionTier: "Pro+",
      userEmail: "user@example.com",
      model: "Composer 2.5",
      cliVersion: "2026.08.11-e8db854",
    });
    assert.ok(lines.some((l) => l.includes("Plan: Pro+")));
    assert.ok(lines.some((l) => l.includes("cursor.com/settings")));
  });

  it("builds a prompt with system prompt, tools, and transcript", () => {
    const prompt = buildPrompt({
      systemPrompt: "Be terse.",
      tools: [{ name: "read", description: "Read files", parameters: {} }],
      messages: [],
    });
    assert.match(prompt, /Pi\/Cursor CLI bridge instructions/);
    assert.match(prompt, /cursor-agent -p/);
    assert.match(prompt, /Be terse\./);
    assert.match(prompt, /"name": "read"/);
    assert.match(prompt, /\(no prior messages\)/);
  });

  it("serializes transcript messages including tool results", () => {
    const prompt = buildPrompt({
      systemPrompt: "",
      tools: [],
      messages: [
        { role: "user", content: "list files" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
          ],
        },
        { role: "toolResult", toolName: "bash", toolCallId: "t1", isError: false, content: "a.txt" },
        { role: "user", content: "thanks" },
      ],
    });
    assert.match(prompt, /USER:\nlist files/);
    assert.match(prompt, /<pi_tool_call>\s*\{[\s\S]*"name": "bash"/);
    assert.match(prompt, /PI TOOL RESULT \(bash, id=t1/);
    assert.match(prompt, /a\.txt/);
  });

  it("parses pi_tool_call markers into Pi tool calls", () => {
    const text = 'Some prose\n<pi_tool_call>{"name":"read","arguments":{"path":"a.md"}}</pi_tool_call>';
    const calls = parseToolCalls(text);
    assert.deepEqual(calls, [{ name: "read", arguments: { path: "a.md" } }]);
  });

  it("ignores malformed or missing tool calls", () => {
    assert.deepEqual(parseToolCalls("<pi_tool_call>not json</pi_tool_call>"), []);
    assert.deepEqual(parseToolCalls("plain answer"), []);
    assert.deepEqual(
      parseToolCalls('<pi_tool_call>{"arguments":{}}</pi_tool_call>'),
      [],
    );
  });

  it("accepts alternative tool-call shapes", () => {
    const calls = parseToolCalls(
      '<pi_tool_call>[{"tool":"bash","args":{"command":"ls"}}]</pi_tool_call>',
    );
    assert.deepEqual(calls, [{ name: "bash", arguments: { command: "ls" } }]);
  });
});
