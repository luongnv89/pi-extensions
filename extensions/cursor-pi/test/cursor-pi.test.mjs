import { describe, it } from "node:test";
import assert from "node:assert/strict";
import cursorPiExtension, {
  buildCursorArgs,
  buildPrompt,
  configuredModels,
  formatUsageLines,
  parseAboutText,
  parseModelsList,
  parseToolCalls,
  PROVIDER_ID,
  showCursorPanelList,
} from "../dist/index.js";

it("bounds detail pages, traverses duplicates and action-like data, and handles all exits", async () => {
  const records = ["Back", "Next", "Close", "Previous", "Back"];
  const actions = ["detail", ...Array.from({ length: 4 }, () => ["Next", "detail"]).flat(), "Next", ...Array(4).fill("Previous"), "Previous", "Back"];
  const pages = [];
  const result = await showCursorPanelList({ ui: { async select(title, options) {
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
  for (const [records, answer, detail, outcome] of [[[], "Back", "No details available.", "back"], [["Close"], "Close", "Close", "close"], [["Previous"], undefined, "Previous", "close"]]) {
    let calls = 0;
    assert.equal(await showCursorPanelList({ ui: { async select(title, options) {
      calls++;
      assert.equal(title, "Details (1/1)");
      assert.deepEqual(options, [`• ${detail}`, "Back", "Close"]);
      return answer;
    } } }, "Details", records), outcome);
    assert.equal(calls, 1);
  }
});

it("splits long ASCII records without loss and keeps page titles within 40 columns", async () => {
  const records = ["Back", "Credentials: managed externally by Cursor CLI (contents not read)", "Next", "z".repeat(91), "Close"];
  const segments = [];
  await showCursorPanelList({ ui: { async select(title, options) {
    assert.ok(title.length <= 38);
    assert.ok(title.startsWith("cursor-pi configuration ("));
    assert.ok(options.length <= 5);
    assert.ok(options[0].startsWith("• "));
    segments.push(options[0].slice(2));
    assert.ok(options[0].slice(2).length <= 40);
    return options.includes("Next") ? "Next" : "Back";
  } } }, "cursor-pi configuration (environment presence)", records);
  assert.equal(segments.join(""), records.join(""));
  assert.deepEqual(segments.slice(0, 2), ["Back", records[1].slice(0, 40)]);
  await showCursorPanelList({ ui: { async select(title) {
    assert.equal(title, `${"X".repeat(30)} (1/1)`);
    return undefined;
  } } }, "X".repeat(80), ["ok"]);
});

function captureCursorCommand() {
  let command;
  cursorPiExtension({
    registerProvider() {},
    on() {},
    registerCommand(name, registered) {
      if (name === "cursor-pi") command = registered;
    },
  });
  if (!command) throw new Error("cursor-pi command was not registered");
  return command;
}

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

  it("hides configured model IDs and shows only a count in the TUI panel", async () => {
    const previous = {
      models: process.env.CURSOR_PI_MODELS,
      bin: process.env.CURSOR_PI_BIN,
      timeout: process.env.CURSOR_PI_TIMEOUT_MS,
      context: process.env.CURSOR_PI_CONTEXT_WINDOW,
    };
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
      "https://user:password@example.test/token",
      "user@example.test",
      "bearer_abcdefghijklmnopqrstuvwxyz0123456789",
    ];
    process.env.CURSOR_PI_MODELS = modelIds.join(",");
    process.env.CURSOR_PI_BIN = "https://user:password@example.test/token";
    process.env.CURSOR_PI_TIMEOUT_MS = "bearer_abcdefghijklmnopqrstuvwxyz0123456789";
    process.env.CURSOR_PI_CONTEXT_WINDOW = "user@example.test";

    try {
      const command = captureCursorCommand();
      const selections = [];
      const choices = ["Models (cached)", "Close"];
      await command.handler("", {
        mode: "tui",
        hasUI: true,
        ui: {
          async select(title, options) {
            selections.push({ title, options });
            return title !== "cursor-pi (read-only)" && options.includes("Next") ? "Next" : choices.shift();
          },
          notify() {
            throw new Error("the read-only panel must not notify");
          },
        },
      });

      assert.ok(selections.length >= 3);
      assert.ok(selections[0].options.includes("Close"));
      const modelPanelText = JSON.stringify(selections);
      assert.match(modelPanelText, new RegExp(`Registered models: ${modelIds.length}`));
      assert.match(selections.map(({ options }) => options[0]?.startsWith("• ") ? options[0].slice(2) : "").join(""), /IDs hidden to avoid exposing configured values/);
      for (const modelId of modelIds) assert.equal(modelPanelText.includes(modelId), false);
      for (const secret of secretValues) assert.equal(modelPanelText.includes(secret), false);

      const configSelections = [];
      const configChoices = ["Configuration (environment presence)", "Close"];
      await command.handler("", {
        mode: "tui",
        hasUI: true,
        ui: {
          async select(title, options) {
            configSelections.push({ title, options });
            return title !== "cursor-pi (read-only)" && options.includes("Next") ? "Next" : configChoices.shift();
          },
        },
      });
      const configPanelText = JSON.stringify(configSelections);
      assert.match(configPanelText, /CURSOR_PI_BIN: set/);
      assert.match(configPanelText, /CURSOR_PI_MODELS: set/);
      assert.match(configPanelText, /CURSOR_PI_TIMEOUT_MS: set/);
      assert.match(configPanelText, /CURSOR_PI_CONTEXT_WINDOW: set/);
      for (const secret of secretValues) assert.equal(configPanelText.includes(secret), false);

      const explicitNotifications = [];
      let selectCalls = 0;
      await command.handler("help", {
        mode: "tui",
        hasUI: true,
        ui: {
          async select() {
            selectCalls += 1;
            throw new Error("explicit subcommands must not open the panel");
          },
          notify(message) {
            explicitNotifications.push(message);
          },
        },
      });
      assert.equal(selectCalls, 0);
      assert.ok(explicitNotifications.some((message) => message.includes("Usage: /cursor-pi")));
    } finally {
      for (const [key, value] of Object.entries({
        CURSOR_PI_MODELS: previous.models,
        CURSOR_PI_BIN: previous.bin,
        CURSOR_PI_TIMEOUT_MS: previous.timeout,
        CURSOR_PI_CONTEXT_WINDOW: previous.context,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("keeps detail rows in detail and supports Back, another section, Close, and Escape", async () => {
    const command = captureCursorCommand();
    const selections = [];
    const topChoices = ["Status (cached)", "Configuration (environment presence)"];
    let statusDetailVisits = 0;

    await command.handler("", {
      mode: "tui",
      hasUI: true,
      ui: {
        async select(title, options) {
          selections.push({ title, options });
          if (title === "cursor-pi (read-only)") return topChoices.shift();
          if (title.startsWith("Cursor CLI status (cached) (")) {
            if (statusDetailVisits++ === 0) return options[0];
            return "Back";
          }
          if (title.startsWith("cursor-pi configuration (")) return "Close";
          throw new Error(`unexpected panel ${title}`);
        },
      },
    });

    assert.deepEqual(selections.map(({ title }) => title), [
      "cursor-pi (read-only)",
      "Cursor CLI status (cached) (1/3)",
      "Cursor CLI status (cached) (1/3)",
      "cursor-pi (read-only)",
      "cursor-pi configuration (1/4)",
    ]);
    assert.ok(selections[1].options.includes("Back"));
    assert.ok(selections[1].options.includes("Close"));
    assert.ok(selections[2].options.includes("Back"));
    assert.ok(selections[4].options.includes("Back"));
    assert.ok(selections[4].options.includes("Close"));

    const escapedSelections = [];
    await command.handler("", {
      mode: "tui",
      hasUI: true,
      ui: {
        async select(title, options) {
          escapedSelections.push({ title, options });
          return title === "cursor-pi (read-only)" ? "Models (cached)" : undefined;
        },
      },
    });
    assert.deepEqual(escapedSelections.map(({ title }) => title), [
      "cursor-pi (read-only)",
      "Cursor models (cached) (1/3)",
    ]);
    assert.ok(escapedSelections[1].options.includes("Back"));
    assert.ok(escapedSelections[1].options.includes("Close"));
  });

  it("cancels the TUI panel and preserves non-TUI bare-command fallback", async () => {
    const previousBin = process.env.CURSOR_PI_BIN;
    process.env.CURSOR_PI_BIN = "/tmp/cursor-panel-missing-bin";

    try {
      const command = captureCursorCommand();
      let selectCalls = 0;
      await command.handler("", {
        mode: "tui",
        hasUI: true,
        ui: {
          async select() {
            selectCalls += 1;
            return undefined;
          },
          notify() {
            throw new Error("cancelled panel must not notify");
          },
        },
      });
      assert.equal(selectCalls, 1);

      const notifications = [];
      selectCalls = 0;
      for (const mode of ["tui", "print"]) {
        await command.handler("", {
          mode,
          hasUI: false,
          ui: {
            async select() {
              selectCalls += 1;
              throw new Error("a context without UI must not select");
            },
            notify(message) {
              notifications.push(message);
            },
          },
        });
      }
      assert.equal(selectCalls, 0);
      assert.ok(notifications.length > 0);
    } finally {
      if (previousBin === undefined) delete process.env.CURSOR_PI_BIN;
      else process.env.CURSOR_PI_BIN = previousBin;
    }
  });
});
