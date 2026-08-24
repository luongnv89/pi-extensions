import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCursorArgs,
  buildPrompt,
  configuredModels,
  formatUsageLines,
  parseAboutText,
  parseModelsList,
  parseToolCalls,
  PROVIDER_ID,
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

  it("builds strict print-mode args in read-only ask mode", () => {
    assert.deepEqual(buildCursorArgs("auto"), [
      "-p",
      "--output-format",
      "text",
      "--model",
      "auto",
      "--mode",
      "ask",
      "--trust",
    ]);
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
    assert.match(prompt, /--mode ask/);
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
