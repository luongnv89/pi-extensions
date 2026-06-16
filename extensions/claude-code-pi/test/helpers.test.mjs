import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeArgs,
  buildPrompt,
  configuredModels,
  PROVIDER_ID,
} from "../dist/index.js";

describe("claude-code-pi helpers", () => {
  it("registers Claude Code aliases by default", () => {
    assert.equal(PROVIDER_ID, "claude-code-cli");
    assert.deepEqual(
      configuredModels(undefined).map((model) => model.id),
      ["sonnet", "opus", "fable"],
    );
  });

  it("parses custom model aliases without duplicates", () => {
    const models = configuredModels("sonnet,claude-fable-5 sonnet");

    assert.deepEqual(
      models.map((model) => model.id),
      ["sonnet", "claude-fable-5"],
    );
    assert.equal(models[1].name, "Claude Code claude-fable-5");
  });

  it("builds a strict claude -p command argument list", () => {
    assert.deepEqual(buildClaudeArgs("opus"), [
      "-p",
      "--model",
      "opus",
      "--no-session-persistence",
      "--permission-mode",
      "dontAsk",
      "--tools",
      "",
      "--output-format",
      "text",
    ]);
  });

  it("serializes Pi context and documents the strict transport boundary", () => {
    const prompt = buildPrompt({
      systemPrompt: "System guidance",
      tools: [
        {
          name: "read",
          description: "Read file contents",
          parameters: { type: "object", properties: {} },
        },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      ],
    });

    assert.match(prompt, /strictly with `claude -p`/);
    assert.match(prompt, /Claude Code's own tools are disabled/);
    assert.match(prompt, /<pi_tool_call>/);
    assert.match(prompt, /Use only tools listed/);
    assert.match(prompt, /System guidance/);
    assert.match(prompt, /USER:\nHello/);
    assert.match(prompt, /ASSISTANT:\nHi/);
    assert.match(prompt, /Read file contents/);
  });
});
