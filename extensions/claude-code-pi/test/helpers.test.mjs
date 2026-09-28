import { describe, it } from "node:test";
import assert from "node:assert/strict";
import claudeCodePiExtension, {
  buildClaudeArgs,
  buildPrompt,
  buildStreamJsonInput,
  configuredModels,
  effortArgs,
  parseStreamJsonOutput,
  PROVIDER_ID,
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
