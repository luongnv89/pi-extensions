import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clearApiProviders } from "@earendil-works/pi-ai";

register("./resolve-ts-imports.mjs", import.meta.url);

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { default: grokPiExtension, showGrokPanelList } = await import(
  pathToFileURL(join(extRoot, "src/index.ts")).href,
);

test("detail pagination bounds options and preserves ordered action-like duplicates", async () => {
  const records = ["Back", "Next", "Close", "Previous", "Back"];
  const actions = ["detail", ...Array.from({ length: 4 }, () => ["Next", "detail"]).flat(), "Next", ...Array(4).fill("Previous"), "Previous", "Back"];
  const pages = [];
  const result = await showGrokPanelList({ ui: { async select(title, options) {
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
    assert.equal(await showGrokPanelList({ ui: { async select(title, options) {
      calls++;
      assert.equal(title, "Details (1/1)");
      assert.deepEqual(options, [`• ${detail}`, "Back", "Close"]);
      return answer;
    } } }, "Details", records), outcome);
    assert.equal(calls, 1);
  }
});

test("long ASCII details keep every character in order with bounded titles and options", async () => {
  const records = ["Back", "Credentials: managed externally by Grok CLI (contents not read)", "Next", "z".repeat(91), "Close"];
  const segments = [];
  await showGrokPanelList({ ui: { async select(title, options) {
    assert.ok(title.length <= 38);
    assert.ok(title.startsWith("grok-pi configuration ("));
    assert.ok(options.length <= 5);
    assert.ok(options[0].startsWith("• "));
    segments.push(options[0].slice(2));
    assert.ok(options[0].slice(2).length <= 40);
    return options.includes("Next") ? "Next" : "Back";
  } } }, "grok-pi configuration (environment presence)", records);
  assert.equal(segments.join(""), records.join(""));
  assert.deepEqual(segments.slice(0, 2), ["Back", records[1].slice(0, 40)]);
  await showGrokPanelList({ ui: { async select(title) {
    assert.equal(title, `${"X".repeat(30)} (1/1)`);
    return undefined;
  } } }, "X".repeat(80), ["ok"]);
});

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function captureCommand() {
  let command;
  grokPiExtension({
    registerProvider() {},
    on() {},
    registerCommand(name, registered) {
      if (name === "grok-pi") command = registered;
    },
  });
  if (!command) throw new Error("grok-pi command was not registered");
  return command;
}

function fakeGrokBin(markerPath) {
  const binPath = join(dirname(markerPath), "grok-panel-fake.sh");
  writeFileSync(
    binPath,
    `#!/bin/sh\nprintf invoked > ${JSON.stringify(markerPath)}\nprintf 'grok 9.9.9'\n`,
    "utf8",
  );
  chmodSync(binPath, 0o755);
  return binPath;
}

test("bare grok-pi opens a cancellable read-only panel without probing the CLI", async () => {
  const home = mkdtempSync(join(tmpdir(), "grok-pi-panel-"));
  const previous = {
    home: process.env.GROK_PI_HOME,
    bin: process.env.GROK_PI_BIN,
    models: process.env.GROK_PI_MODELS,
    timeout: process.env.GROK_PI_TIMEOUT_MS,
  };
  const marker = join(home, "cli-invoked");
  const modelIds = [
    "auto",
    "composer-2.5",
    "opencode/model",
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
    ...modelIds.slice(3),
    "bearer_abcdefghijklmnopqrstuvwxyz0123456789",
    join(home, "user@example.test"),
  ];
  process.env.GROK_PI_HOME = join(home, "user@example.test");
  process.env.GROK_PI_BIN = fakeGrokBin(marker);
  process.env.GROK_PI_MODELS = modelIds.join(",");
  process.env.GROK_PI_TIMEOUT_MS = "bearer_abcdefghijklmnopqrstuvwxyz0123456789";

  try {
    const command = captureCommand();
    const selections = [];
    const choices = ["Status (cached)", "Close"];
    await command.handler("", {
      mode: "tui",
      hasUI: true,
      ui: {
        async select(title, options) {
          selections.push({ title, options });
          return title !== "grok-pi (read-only)" && options.includes("Next") ? "Next" : choices.shift();
        },
        notify() {
          throw new Error("the read-only panel must not notify");
        },
      },
    });

    assert.ok(selections.length >= 4);
    assert.ok(selections[0].options.includes("Close"));
    assert.equal(existsSync(marker), false);
    const statusPanelText = JSON.stringify(selections);
    for (const secret of secretValues) assert.equal(statusPanelText.includes(secret), false);

    const configSelections = [];
    const configChoices = ["Configuration (environment presence)", "Close"];
    await command.handler("", {
      mode: "tui",
      hasUI: true,
      ui: {
        async select(title, options) {
          configSelections.push({ title, options });
          return title !== "grok-pi (read-only)" && options.includes("Next") ? "Next" : configChoices.shift();
        },
      },
    });
    const configPanelText = JSON.stringify(configSelections);
    assert.match(configPanelText, /GROK_PI_BIN: set/);
    assert.match(configPanelText, /GROK_PI_MODELS: set/);
    assert.match(configPanelText, /GROK_PI_TIMEOUT_MS: set/);
    assert.match(configPanelText, /GROK_PI_HOME: set/);
    for (const secret of secretValues) assert.equal(configPanelText.includes(secret), false);
    assert.equal(configPanelText.includes(process.env.GROK_PI_BIN), false);
  } finally {
    clearApiProviders();
    restoreEnv("GROK_PI_HOME", previous.home);
    restoreEnv("GROK_PI_BIN", previous.bin);
    restoreEnv("GROK_PI_MODELS", previous.models);
    restoreEnv("GROK_PI_TIMEOUT_MS", previous.timeout);
    rmSync(home, { recursive: true, force: true });
  }
});

test("grok-pi panel hides configured model IDs, supports cancellation, and is side-effect free", async () => {
  const home = mkdtempSync(join(tmpdir(), "grok-pi-panel-"));
  const previous = {
    home: process.env.GROK_PI_HOME,
    bin: process.env.GROK_PI_BIN,
    models: process.env.GROK_PI_MODELS,
    timeout: process.env.GROK_PI_TIMEOUT_MS,
  };
  process.env.GROK_PI_HOME = home;
  process.env.GROK_PI_BIN = join(home, "missing-grok");
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
  process.env.GROK_PI_MODELS = modelIds.join(",");
  process.env.GROK_PI_TIMEOUT_MS = "token_0123456789abcdef";

  try {
    const command = captureCommand();
    let calls = 0;
    await command.handler("", {
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

    const selections = [];
    const choices = ["Models (cached)", "Close"];
    await command.handler("", {
      mode: "tui",
      hasUI: true,
      ui: {
        async select(title, options) {
          selections.push({ title, options });
          return title !== "grok-pi (read-only)" && options.includes("Next") ? "Next" : choices.shift();
        },
      },
    });
    const modelPanelText = JSON.stringify(selections);
    assert.match(modelPanelText, new RegExp(`Cached models: ${modelIds.length}`));
    assert.match(selections.map(({ options }) => options[0]?.startsWith("• ") ? options[0].slice(2) : "").join(""), /IDs hidden to avoid exposing configured values/);
    for (const modelId of modelIds) assert.equal(modelPanelText.includes(modelId), false);

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
    assert.ok(explicitNotifications.some((message) => message.includes("Usage: /grok-pi")));
  } finally {
    clearApiProviders();
    restoreEnv("GROK_PI_HOME", previous.home);
    restoreEnv("GROK_PI_BIN", previous.bin);
    restoreEnv("GROK_PI_MODELS", previous.models);
    restoreEnv("GROK_PI_TIMEOUT_MS", previous.timeout);
    rmSync(home, { recursive: true, force: true });
  }
});

test("grok-pi keeps informational rows in detail and supports Back, another section, Close, and Escape", async () => {
  try {
    const command = captureCommand();
    const selections = [];
    const topChoices = ["Status (cached)", "Configuration (environment presence)"];
    let statusDetailVisits = 0;

    await command.handler("", {
      mode: "tui",
      hasUI: true,
      ui: {
        async select(title, options) {
          selections.push({ title, options });
          if (title === "grok-pi (read-only)") return topChoices.shift();
          if (title.startsWith("Grok CLI status (cached) (")) {
            if (statusDetailVisits++ === 0) return options[0];
            return "Back";
          }
          if (title.startsWith("grok-pi configuration (")) return "Close";
          throw new Error(`unexpected panel ${title}`);
        },
      },
    });

    assert.deepEqual(selections.map(({ title }) => title), [
      "grok-pi (read-only)",
      "Grok CLI status (cached) (1/3)",
      "Grok CLI status (cached) (1/3)",
      "grok-pi (read-only)",
      "grok-pi configuration (1/4)",
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
          return title === "grok-pi (read-only)" ? "Models (cached)" : undefined;
        },
      },
    });
    assert.deepEqual(escapedSelections.map(({ title }) => title), [
      "grok-pi (read-only)",
      "Grok models (cached) (1/3)",
    ]);
    assert.ok(escapedSelections[1].options.includes("Back"));
    assert.ok(escapedSelections[1].options.includes("Close"));
  } finally {
    clearApiProviders();
  }
});

test("bare grok-pi keeps the existing non-TUI status fallback", async () => {
  const previous = {
    home: process.env.GROK_PI_HOME,
    bin: process.env.GROK_PI_BIN,
    models: process.env.GROK_PI_MODELS,
    timeout: process.env.GROK_PI_TIMEOUT_MS,
  };
  process.env.GROK_PI_HOME = mkdtempSync(join(tmpdir(), "grok-pi-panel-"));
  process.env.GROK_PI_BIN = join(process.env.GROK_PI_HOME, "missing-grok");
  delete process.env.GROK_PI_MODELS;

  try {
    const command = captureCommand();
    const notifications = [];
    let selectCalls = 0;
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
    const home = process.env.GROK_PI_HOME;
    clearApiProviders();
    restoreEnv("GROK_PI_HOME", previous.home);
    restoreEnv("GROK_PI_BIN", previous.bin);
    restoreEnv("GROK_PI_MODELS", previous.models);
    restoreEnv("GROK_PI_TIMEOUT_MS", previous.timeout);
    if (home) rmSync(home, { recursive: true, force: true });
  }
});
