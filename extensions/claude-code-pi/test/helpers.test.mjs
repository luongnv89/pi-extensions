import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeArgs,
  buildPrompt,
  buildStreamJsonInput,
  configuredModels,
  effortArgs,
  parseStreamJsonOutput,
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

  it("maps Pi thinking levels to claude --effort flags", () => {
    assert.deepEqual(effortArgs(undefined), []);
    assert.deepEqual(effortArgs("off"), []);
    assert.deepEqual(effortArgs("minimal"), ["--effort", "low"]);
    assert.deepEqual(effortArgs("low"), ["--effort", "low"]);
    assert.deepEqual(effortArgs("medium"), ["--effort", "medium"]);
    assert.deepEqual(effortArgs("high"), ["--effort", "high"]);
    assert.deepEqual(effortArgs("xhigh"), ["--effort", "xhigh"]);
    assert.ok(buildClaudeArgs("sonnet", "high").includes("--effort"));
  });

  it("switches to stream-json transport when images are present", () => {
    const args = buildClaudeArgs("sonnet", "medium", true);
    assert.ok(args.includes("--input-format"));
    assert.ok(args.includes("stream-json"));
    assert.ok(args.includes("--verbose"));
    assert.ok(!args.includes("text"));
  });

  it("advertises a 1M context window with env override support", () => {
    const models = configuredModels(undefined);
    assert.equal(models[0].contextWindow, 1_000_000);
  });

  it("wraps images and prompt into a stream-json user message", () => {
    const input = buildStreamJsonInput(
      [{ type: "image", mimeType: "image/png", data: "aGk=" }],
      "Describe this.",
    );
    const parsed = JSON.parse(input);
    assert.equal(parsed.type, "user");
    assert.equal(parsed.message.role, "user");
    assert.equal(parsed.message.content[0].type, "image");
    assert.equal(parsed.message.content[0].source.media_type, "image/png");
    assert.equal(parsed.message.content[0].source.data, "aGk=");
    assert.equal(parsed.message.content[1].text, "Describe this.");
  });

  it("extracts text from stream-json output events", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Red" }] } }),
      JSON.stringify({ type: "result", result: "Red" }),
      "not json",
    ].join("\n");
    assert.equal(parseStreamJsonOutput(stdout), "Red");
    assert.equal(parseStreamJsonOutput(""), "");
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
