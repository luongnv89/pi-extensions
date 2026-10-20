import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import claudeCodePiExtension, {
  buildClaudeArgs,
  buildPrompt,
  buildStreamJsonInput,
  configuredModels,
  contextImages,
  effortArgs,
  normalizeContent,
  parseClaudeOutput,
  PROVIDER_ID,
  resolveTurnSystemPrompt,
  resolveTurnTools,
  showClaudePanelList,
} from "../dist/index.js";

it("pages every detail safely, supports Back/Close/Escape and empty or singleton lists", async () => {
  const lines = ["Back", "Next", "Close", "Previous", "Back"];
  const actions = ["detail", ...Array.from({ length: 4 }, () => ["Next", "detail"]).flat(), "Next", ...Array(4).fill("Previous"), "Previous", "Back"];
  const pages = [];
  const result = await showClaudePanelList({ ui: { async select(title, options) {
    assert.ok(pages.length < actions.length);
    const previous = pages.at(-1) ?? 1;
    const action = actions[pages.length - 1];
    const page = pages.length === 0 ? 1 : action === "Next" ? Math.min(5, previous + 1) : action === "Previous" ? Math.max(1, previous - 1) : previous;
    pages.push(page);
    assert.equal(title, `Details (${page}/5)`);
    assert.deepEqual(options, [`• ${lines[page - 1]}`, ...(page > 1 ? ["Previous"] : []), ...(page < 5 ? ["Next"] : []), "Back", "Close"]);
    assert.ok(options.length <= 5);
    return actions[pages.length - 1] === "detail" ? options[0] : actions[pages.length - 1];
  } } }, "Details", lines);
  assert.equal(result, "Back");
  assert.deepEqual(pages, [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 5, 4, 3, 2, 1, 1]);
  for (const [records, answer, detail] of [[[], "Back", "No details available."], [["Close"], "Close", "Close"], [["Previous"], undefined, "Previous"]]) {
    let calls = 0;
    assert.equal(await showClaudePanelList({ ui: { async select(title, options) {
      calls++;
      assert.equal(title, "Details (1/1)");
      assert.deepEqual(options, [`• ${detail}`, "Back", "Close"]);
      return answer;
    } } }, "Details", records), answer);
    assert.equal(calls, 1);
  }
});

it("preserves every byte and order across bounded display segments and shortens long titles", async () => {
  const records = ["Back", "Credentials: managed externally by Claude Code CLI (contents not read)", "Next", "z".repeat(91), "Close"];
  const segments = [];
  await showClaudePanelList({ ui: { async select(title, options) {
    assert.ok(title.length <= 38);
    assert.ok(title.startsWith("claude-code-pi configuration ("));
    assert.ok(options.length <= 5);
    assert.ok(options[0].startsWith("• "));
    segments.push(options[0].slice(2));
    assert.ok(options[0].slice(2).length <= 40);
    return options.includes("Next") ? "Next" : "Back";
  } } }, "claude-code-pi configuration (source presence)", records);
  assert.equal(segments.join(""), records.join(""));
  assert.deepEqual(segments.slice(0, 2), ["Back", records[1].slice(0, 40)]);
  await showClaudePanelList({ ui: { async select(title) {
    assert.equal(title, `${"X".repeat(30)} (1/1)`);
    return undefined;
  } } }, "X".repeat(80), ["ok"]);
});

describe("claude-code-pi helpers", () => {
  it("registers Claude Code aliases by default", () => {
    assert.equal(PROVIDER_ID, "claude-code-cli");
    assert.deepEqual(
      configuredModels(undefined).map((model) => model.id),
      ["sonnet", "opus", "fable", "haiku"],
    );
  });

  it("advertises the output limits Claude Code reports for each alias", () => {
    const limits = Object.fromEntries(configuredModels(undefined).map((model) => [model.id, model.maxTokens]));
    assert.deepEqual(limits, { sonnet: 128_000, opus: 128_000, fable: 64_000, haiku: 128_000 });
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
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--output-format",
      "json",
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
    assert.deepEqual(effortArgs("max"), ["--effort", "max"]);
    assert.ok(buildClaudeArgs("sonnet", "high").includes("--effort"));
  });

  it("declares xhigh and max in every model's thinkingLevelMap so Pi 1.x offers them", () => {
    let provider;
    claudeCodePiExtension({
      registerProvider(_id, config) {
        provider = config;
      },
      registerCommand() {},
      on() {},
    });
    for (const model of provider.models) {
      assert.equal(model.thinkingLevelMap.xhigh, "xhigh");
      assert.equal(model.thinkingLevelMap.max, "max");
      assert.equal(model.thinkingLevelMap.minimal, "low");
    }
  });

  it("switches to stream-json transport when images are present", () => {
    const args = buildClaudeArgs("sonnet", "medium", true);
    assert.ok(args.includes("--input-format"));
    assert.ok(args.includes("stream-json"));
    assert.ok(args.includes("--verbose"));
    assert.ok(!args.includes("json"));
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
    assert.equal(parseClaudeOutput(stdout).text, "Red");
    assert.equal(parseClaudeOutput("").text, "");
  });

  it("reads usage, cost, resolved model, and stop reason from the json result", () => {
    const parsed = parseClaudeOutput(
      JSON.stringify({
        type: "result",
        is_error: false,
        result: "OK",
        stop_reason: "max_tokens",
        total_cost_usd: 0.25,
        usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 1559, cache_creation_input_tokens: 30259 },
        modelUsage: { "claude-opus-5-5": { contextWindow: 1_000_000 } },
      }),
    );
    assert.equal(parsed.text, "OK");
    assert.equal(parsed.isError, false);
    assert.equal(parsed.hasResult, true);
    assert.equal(parsed.stopReason, "max_tokens");
    assert.equal(parsed.responseModel, "claude-opus-5-5");
    assert.deepEqual(parsed.usage, { input: 2, output: 4, cacheRead: 1559, cacheWrite: 30259, costTotal: 0.25 });
  });

  it("flags is_error results and falls back to raw stdout without a result event", () => {
    const failed = parseClaudeOutput(
      `${JSON.stringify({ type: "result", is_error: true, result: "There's an issue with the selected model" })}\n`,
    );
    assert.equal(failed.isError, true);
    assert.equal(failed.text, "There's an issue with the selected model");

    const plain = parseClaudeOutput("plain text from an older CLI\n");
    assert.equal(plain.hasResult, false);
    assert.equal(plain.isError, false);
    assert.equal(plain.text, "plain text from an older CLI");

    const truncated = parseClaudeOutput(`${JSON.stringify({ type: "system", subtype: "init" })}\n`);
    assert.equal(truncated.hasResult, false);
    assert.equal(truncated.text, "", "raw stream-json events must never become the reply");
  });

  it("names the model that produced the answer when several models report usage", () => {
    const parsed = parseClaudeOutput(
      JSON.stringify({
        type: "result",
        result: "OK",
        modelUsage: { "claude-haiku-5-5": { outputTokens: 12 }, "claude-opus-5-5": { outputTokens: 480 } },
      }),
    );
    assert.equal(parsed.responseModel, "claude-opus-5-5");
  });

  it("normalizes string, null, and single-object message content", () => {
    assert.deepEqual(normalizeContent("hi"), [{ type: "text", text: "hi" }]);
    assert.deepEqual(normalizeContent(null), []);
    assert.deepEqual(normalizeContent({ type: "text", text: "x" }), [{ type: "text", text: "x" }]);
    assert.deepEqual(normalizeContent([null, { type: "text", text: "y" }]), [{ type: "text", text: "y" }]);
  });

  it("replays the Pi 1.x transcript system messages into the prompt and tool list", () => {
    const read = { name: "read", description: "Read file contents", parameters: { type: "object", properties: {} } };
    const bash = { name: "bash", description: "Run a shell command", parameters: { type: "object", properties: {} } };
    const context = {
      messages: [
        {
          role: "system",
          content: "Pi 1.x base prompt",
          sections: { rules: "<rules>be brief</rules>", stale: "<stale/>" },
          toolsAdded: [read, bash],
          timestamp: 1,
        },
        { role: "user", content: "Hello", timestamp: 2 },
        { role: "system", content: [], sections: { stale: null }, toolsRemoved: [{ name: "bash" }], timestamp: 3 },
      ],
    };

    assert.deepEqual(resolveTurnTools(context).map((tool) => tool.name), ["read"]);
    assert.equal(resolveTurnSystemPrompt(context), "Pi 1.x base prompt\n\n<rules>be brief</rules>");

    const prompt = buildPrompt(context);
    assert.match(prompt, /# Pi system prompt\n\nPi 1\.x base prompt/);
    assert.match(prompt, /Read file contents/);
    assert.doesNotMatch(prompt, /Run a shell command/);
    assert.doesNotMatch(prompt, /No Pi tools are available/);
    assert.doesNotMatch(prompt, /<stale\/>/);
    assert.match(prompt, /USER:\nHello/);
    assert.doesNotMatch(prompt, /ASSISTANT:\nPi 1\.x base prompt/);
  });

  it("attaches user and tool-result images in transcript order and labels them in the prompt", () => {
    const context = {
      messages: [
        { role: "system", content: "prompt", timestamp: 1 },
        { role: "user", content: [{ type: "text", text: "Look" }, { type: "image", mimeType: "image/png", data: "AAA" }] },
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "b.jpg" } }] },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "Read image file" }, { type: "image", mimeType: "image/jpeg", data: "BBB" }],
        },
      ],
    };

    assert.deepEqual(contextImages(context).map((image) => image.data), ["AAA", "BBB"]);
    const prompt = buildPrompt(context);
    assert.match(prompt, /\[image 1 \(image\/png\): attached to this request\]/);
    assert.match(prompt, /\[image 2 \(image\/jpeg\): attached to this request\]/);
    assert.match(prompt, /"id": "call-1"/);
    assert.doesNotMatch(prompt, /image omitted/);
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

  it("opens only the read-only TUI panel, preserves routing, and hides all model IDs", async () => {
    const previousBin = process.env.CLAUDE_CODE_PI_BIN;
    const previousModels = process.env.CLAUDE_CODE_PI_MODELS;
    const previousTimeout = process.env.CLAUDE_CODE_PI_TIMEOUT_MS;
    const previousContextWindow = process.env.CLAUDE_CODE_PI_CONTEXT_WINDOW;
    const adversarialSecret = "sk-ABC123";
    const ordinarySecret = "ordinary-looking-model-secret";
    const adversarialUrl = "https://user:password@example.invalid/private?token=raw-secret";
    const adversarialEmail = "person@example.invalid";
    const userPathModelId = "opencode/alice.smith";
    const adversarialJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature";
    const adversarialAnsi = "\u001b[31mansi-secret\u001b[0m";
    process.env.CLAUDE_CODE_PI_BIN = "/tmp/claude-panel-user@example.invalid/bin";
    process.env.CLAUDE_CODE_PI_MODELS = [
      "safe-panel-model",
      adversarialSecret,
      ordinarySecret,
      adversarialUrl,
      adversarialEmail,
      userPathModelId,
      adversarialJwt,
      adversarialAnsi,
      "credential-token-value",
    ].join(",");
    process.env.CLAUDE_CODE_PI_TIMEOUT_MS = adversarialUrl;
    process.env.CLAUDE_CODE_PI_CONTEXT_WINDOW = "present-but-not-displayed";

    try {
      let command;
      let providerRegistrations = 0;
      const pi = {
        registerProvider() {
          providerRegistrations += 1;
        },
        registerCommand(_name, config) {
          command = config;
        },
        on() {},
      };
      claudeCodePiExtension(pi);
      assert.ok(command, "extension should register /claude-code-pi");
      assert.equal(providerRegistrations, 1);

      const selections = [];
      const panelChoices = [
        "Provider status",
        "Back",
        "Configuration (source presence)",
        "Back",
        "Models (registered)",
        "Back",
        "Help / navigation",
        "Back",
        "Close",
      ];
      await command.handler("", {
        mode: "tui",
        hasUI: true,
        ui: {
          async select(title, options) {
            selections.push({ title, options });
            return title !== "claude-code-pi (read-only)" && options.includes("Next") ? "Next" : panelChoices.shift();
          },
          notify() {
            throw new Error("the read-only panel must not notify");
          },
        },
      });

      assert.ok(selections.length > 22);
      assert.equal(panelChoices.length, 0);
      assert.deepEqual(selections[0].options, [
        "Provider status",
        "Configuration (source presence)",
        "Models (registered)",
        "Help / navigation",
        "Close",
      ]);
      const panelText = JSON.stringify(selections);
      const detailText = selections.map(({ options }) => options[0]?.startsWith("• ") ? options[0].slice(2) : "").join("");
      assert.equal(panelText.includes(adversarialSecret), false);
      assert.equal(panelText.includes(ordinarySecret), false);
      assert.equal(panelText.includes(adversarialUrl), false);
      assert.equal(panelText.includes(adversarialEmail), false);
      assert.equal(panelText.includes(userPathModelId), false);
      assert.equal(panelText.includes(adversarialJwt), false);
      assert.equal(panelText.includes(adversarialAnsi), false);
      assert.equal(panelText.includes("safe-panel-model"), false);
      assert.equal(panelText.includes("/tmp/claude-panel-user@example.invalid/bin"), false);
      assert.match(panelText, /Registered models: \d+/);
      assert.match(detailText, /CLI model availability not checked/);
      assert.equal(providerRegistrations, 1, "panel selection must not update provider registration");

      let detailCancelledSelects = 0;
      const detailCancellationChoices = ["Provider status", undefined];
      await command.handler("", {
        mode: "tui",
        hasUI: true,
        ui: {
          async select() {
            detailCancelledSelects += 1;
            return detailCancellationChoices.shift();
          },
          notify() {
            throw new Error("cancelling the detail must not notify");
          },
        },
      });
      assert.equal(detailCancelledSelects, 2);

      let cancelledSelects = 0;
      await command.handler("", {
        mode: "tui",
        hasUI: true,
        ui: {
          async select() {
            cancelledSelects += 1;
            return undefined;
          },
          notify() {
            throw new Error("cancelling the panel must not notify");
          },
        },
      });
      assert.equal(cancelledSelects, 1);

      let nonTuiSelects = 0;
      const nonTuiNotifications = [];
      await command.handler("", {
        mode: "print",
        hasUI: false,
        ui: {
          async select() {
            nonTuiSelects += 1;
            throw new Error("non-TUI bare command must not open the panel");
          },
          notify(message) {
            nonTuiNotifications.push(message);
          },
        },
      });
      assert.equal(nonTuiSelects, 0);
      assert.ok(nonTuiNotifications.length > 0);

      let explicitSelects = 0;
      const explicitNotifications = [];
      await command.handler("help", {
        mode: "tui",
        hasUI: true,
        ui: {
          async select() {
            explicitSelects += 1;
            throw new Error("explicit subcommands must not open the panel");
          },
          notify(message) {
            explicitNotifications.push(message);
          },
        },
      });
      assert.equal(explicitSelects, 0);
      assert.equal(explicitNotifications.length, 7);
    } finally {
      if (previousBin === undefined) delete process.env.CLAUDE_CODE_PI_BIN;
      else process.env.CLAUDE_CODE_PI_BIN = previousBin;
      if (previousModels === undefined) delete process.env.CLAUDE_CODE_PI_MODELS;
      else process.env.CLAUDE_CODE_PI_MODELS = previousModels;
      if (previousTimeout === undefined) delete process.env.CLAUDE_CODE_PI_TIMEOUT_MS;
      else process.env.CLAUDE_CODE_PI_TIMEOUT_MS = previousTimeout;
      if (previousContextWindow === undefined) delete process.env.CLAUDE_CODE_PI_CONTEXT_WINDOW;
      else process.env.CLAUDE_CODE_PI_CONTEXT_WINDOW = previousContextWindow;
    }
  });
});

describe("claude-code-pi streamSimple", () => {
  function provider() {
    let config;
    claudeCodePiExtension({
      registerProvider(_id, value) {
        config = value;
      },
      registerCommand() {},
      on() {},
    });
    return config;
  }

  const model = { id: "sonnet", api: "claude-code-cli-runner", provider: PROVIDER_ID, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

  // Pi 1.x context: the prompt and tools arrive as a leading system message with string content.
  const piOneContext = {
    messages: [
      {
        role: "system",
        content: "Pi 1.x system prompt",
        toolsAdded: [{ name: "read", description: "Read file contents", parameters: { type: "object", properties: {} } }],
        timestamp: 1,
      },
      { role: "user", content: "Hello", timestamp: 2 },
    ],
  };

  async function withFakeClaude(script, run) {
    const dir = mkdtempSync(join(tmpdir(), "claude-code-pi-"));
    const bin = join(dir, "claude");
    writeFileSync(bin, `#!/usr/bin/env node\n${script}\n`);
    chmodSync(bin, 0o755);
    const previous = process.env.CLAUDE_CODE_PI_BIN;
    process.env.CLAUDE_CODE_PI_BIN = bin;
    try {
      return await run(dir);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_PI_BIN;
      else process.env.CLAUDE_CODE_PI_BIN = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("serves a Pi 1.x transcript with real usage and the resolved model", async () => {
    const message = await withFakeClaude(
      `const fs = require("node:fs");
const input = fs.readFileSync(0, "utf8");
fs.writeFileSync(require("node:path").join(__dirname, "capture.json"), JSON.stringify({ args: process.argv.slice(2), input }));
process.stdout.write(JSON.stringify({
  type: "result", is_error: false, result: "Hi there", stop_reason: "end_turn", total_cost_usd: 0.12,
  usage: { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 900 },
  modelUsage: { "claude-sonnet-5-5": {} },
}));`,
      async (dir) => {
        const result = await provider().streamSimple(model, piOneContext, { reasoning: "max" }).result();
        const capture = JSON.parse(readFileSync(join(dir, "capture.json"), "utf8"));
        assert.ok(capture.args.includes("--strict-mcp-config"));
        assert.deepEqual(capture.args.slice(capture.args.indexOf("--effort"), capture.args.indexOf("--effort") + 2), ["--effort", "max"]);
        assert.match(capture.input, /# Pi system prompt\n\nPi 1\.x system prompt/);
        assert.match(capture.input, /Read file contents/);
        return result;
      },
    );

    assert.equal(message.stopReason, "stop");
    assert.equal(message.errorMessage, undefined);
    assert.deepEqual(message.content, [{ type: "text", text: "Hi there" }]);
    assert.equal(message.responseModel, "claude-sonnet-5-5");
    assert.equal(message.usage.input, 3);
    assert.equal(message.usage.output, 5);
    assert.equal(message.usage.cacheRead, 100);
    assert.equal(message.usage.cacheWrite, 900);
    assert.equal(message.usage.totalTokens, 1008);
    assert.equal(message.usage.cost.total, 0.12);
  });

  it("turns pi_tool_call markers into Pi tool calls", async () => {
    const message = await withFakeClaude(
      `require("node:fs").readFileSync(0);
process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: '<pi_tool_call>{"name":"read","arguments":{"path":"a.txt"}}</pi_tool_call>' }));`,
      () => provider().streamSimple(model, piOneContext).result(),
    );

    assert.equal(message.stopReason, "toolUse");
    assert.equal(message.content[0].type, "toolCall");
    assert.equal(message.content[0].name, "read");
    assert.deepEqual(message.content[0].arguments, { path: "a.txt" });
  });

  it("maps max_tokens to a length stop", async () => {
    const message = await withFakeClaude(
      `require("node:fs").readFileSync(0);
process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "truncated", stop_reason: "max_tokens" }));`,
      () => provider().streamSimple(model, piOneContext).result(),
    );
    assert.equal(message.stopReason, "length");
  });

  it("reports an is_error result even when claude exits 0 (stream-json)", async () => {
    const message = await withFakeClaude(
      `require("node:fs").readFileSync(0);
process.stdout.write(JSON.stringify({ type: "result", is_error: true, result: "There's an issue with the selected model (nope)." }) + "\\n");`,
      () => provider().streamSimple(model, piOneContext).result(),
    );
    assert.equal(message.stopReason, "error");
    assert.match(message.errorMessage, /There's an issue with the selected model/);
    assert.doesNotMatch(message.errorMessage, /Install Claude Code/);
  });

  it("prefers the result text over stderr warnings when claude exits non-zero", async () => {
    const message = await withFakeClaude(
      `require("node:fs").readFileSync(0);
process.stderr.write("Warning: Advisor disabled\\n");
process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "Rate limit reached" }));
process.exitCode = 1;`,
      () => provider().streamSimple(model, piOneContext).result(),
    );
    assert.equal(message.stopReason, "error");
    assert.match(message.errorMessage, /Rate limit reached/);
    assert.doesNotMatch(message.errorMessage, /Advisor disabled/);
  });

  it("gives setup guidance only when the claude binary cannot start", async () => {
    const previous = process.env.CLAUDE_CODE_PI_BIN;
    process.env.CLAUDE_CODE_PI_BIN = join(tmpdir(), "claude-code-pi-missing", "claude");
    try {
      const message = await provider().streamSimple(model, piOneContext).result();
      assert.equal(message.stopReason, "error");
      assert.match(message.errorMessage, /ENOENT/);
      assert.match(message.errorMessage, /Install Claude Code/);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_PI_BIN;
      else process.env.CLAUDE_CODE_PI_BIN = previous;
    }
  });

  it("does not spawn claude when the request is already aborted", async () => {
    const message = await withFakeClaude(
      `require("node:fs").writeFileSync(require("node:path").join(__dirname, "spawned"), "1");`,
      async (dir) => {
        const controller = new AbortController();
        controller.abort();
        const result = await provider().streamSimple(model, piOneContext, { signal: controller.signal }).result();
        assert.throws(() => readFileSync(join(dir, "spawned")));
        return result;
      },
    );
    assert.equal(message.stopReason, "aborted");
  });
});
