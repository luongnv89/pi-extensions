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
const { default: grokPiExtension } = await import(
  pathToFileURL(join(extRoot, "src/index.ts")).href,
);

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
    "sk-proj-1234567890abcdef",
    "provider/sk-proj-1234567890abcdef/model",
    "ghp_0123456789abcdefghijklmnopqrstuv",
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
          return choices.shift();
        },
        notify() {
          throw new Error("the read-only panel must not notify");
        },
      },
    });

    assert.equal(selections.length, 2);
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
          return configChoices.shift();
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
    "sk-proj-1234567890abcdef",
    "provider/sk-proj-1234567890abcdef/model",
    "ghp_0123456789abcdefghijklmnopqrstuv",
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
          return choices.shift();
        },
      },
    });
    const modelPanelText = JSON.stringify(selections);
    assert.match(modelPanelText, new RegExp(`Cached models: ${modelIds.length}`));
    assert.match(modelPanelText, /IDs hidden to avoid exposing configured values/);
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
          if (title === "Grok CLI status (cached)") {
            if (statusDetailVisits++ === 0) return options[0];
            return "Back";
          }
          if (title === "grok-pi configuration (environment presence)") return "Close";
          throw new Error(`unexpected panel ${title}`);
        },
      },
    });

    assert.deepEqual(selections.map(({ title }) => title), [
      "grok-pi (read-only)",
      "Grok CLI status (cached)",
      "Grok CLI status (cached)",
      "grok-pi (read-only)",
      "grok-pi configuration (environment presence)",
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
      "Grok models (cached)",
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
