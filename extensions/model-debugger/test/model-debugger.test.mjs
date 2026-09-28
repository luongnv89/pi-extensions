import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sourceUrl = new URL("../index.ts", import.meta.url);
const COMMAND_NAMES = ["model-debugger", "debug-logs", "debug-status", "debug-toggle", "debug-clear", "debug-help"];

async function loadExtension() {
  return import(`${sourceUrl.href}?test=${randomUUID()}`);
}

async function createRuntime({ mode = "tui", hasUI = true, selections = [], omitMode = false } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const notifications = [];
  const selects = [];
  const context = {
    mode,
    hasUI,
    ui: {
      async select(title, options) {
        selects.push({ title, options });
        return selections.shift();
      },
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  };
  if (omitMode) delete context.mode;
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand(name, definition) {
      commands.set(name, definition.handler);
    },
  };

  const extension = await loadExtension();
  extension.default(pi);
  return {
    context,
    commands,
    handlers,
    notifications,
    selects,
    async command(name, args = "") {
      await commands.get(name)(args, context);
    },
    async emit(name, event = {}) {
      await handlers.get(name)?.(event, context);
    },
  };
}

function withHome() {
  const previous = process.env.HOME;
  const root = mkdtempSync(join(tmpdir(), "model-debugger-test-"));
  process.env.HOME = root;
  return {
    root,
    logFile: join(root, ".pi", "agent", "logs", "model-debugger.log"),
    stateFile: join(root, ".pi", "agent", "logs", ".model-debugger-state"),
    cleanup() {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function lineCount(path) {
  return read(path).split("\n").filter(Boolean).length;
}

describe("model-debugger /model-debugger command", { concurrency: false }, () => {
  it("shows a read-only compact TUI panel and does not expose or clear raw logs on Escape", async () => {
    const temp = withHome();
    try {
      const runtime = await createRuntime({ selections: [undefined] });
      appendFileSync(temp.logFile, "credential-looking-secret\n", "utf8");

      await runtime.command("model-debugger");

      assert.equal(runtime.selects.length, 1);
      assert.equal(runtime.selects[0].title, "model-debugger");
      assert.deepEqual(runtime.selects[0].options.slice(0, 2), [
        "Disable model-debugger (currently enabled)",
        "Status: enabled · idle",
      ]);
      assert.match(runtime.selects[0].options[2], /^Log summary: 4 entries · [0-9.]+ (B|KB)$/);
      assert.equal(runtime.selects[0].options[3], "Close");
      assert.equal(existsSync(temp.stateFile), false);
      assert.equal(runtime.notifications.length, 0);
      assert.match(read(temp.logFile), /credential-looking-secret/);
      assert.doesNotMatch(runtime.selects[0].options.join("\n"), /credential-looking-secret/);
    } finally {
      temp.cleanup();
    }
  });

  it("ignores an unexpected select result without mutating state or logs", async () => {
    const temp = withHome();
    try {
      const runtime = await createRuntime({ selections: ["Enable model-debugger (synthetic)"] });
      const before = read(temp.logFile);
      await runtime.command("model-debugger");
      assert.equal(existsSync(temp.stateFile), false);
      assert.equal(runtime.notifications.length, 0);
      assert.equal(read(temp.logFile), before);
    } finally {
      temp.cleanup();
    }
  });

  it("keeps Close read-only and applies panel enable/disable to persistence and event logging", async () => {
    const temp = withHome();
    try {
      const runtime = await createRuntime({
        selections: ["Close", "Disable model-debugger (currently enabled)", "Enable model-debugger (currently disabled)"],
      });
      await runtime.command("model-debugger");
      assert.equal(existsSync(temp.stateFile), false);

      const beforeEnabledEvent = lineCount(temp.logFile);
      await runtime.emit("model_select", {
        model: { provider: "openai", id: "gpt-enabled" },
        source: "set",
      });
      assert.ok(lineCount(temp.logFile) > beforeEnabledEvent);

      await runtime.command("model-debugger");
      assert.equal(read(temp.stateFile), "disabled");
      const afterDisable = lineCount(temp.logFile);
      await runtime.emit("model_select", {
        model: { provider: "openai", id: "gpt-disabled" },
        source: "set",
      });
      assert.equal(lineCount(temp.logFile), afterDisable);

      await runtime.command("model-debugger");
      assert.equal(read(temp.stateFile), "enabled");
      const afterEnable = lineCount(temp.logFile);
      await runtime.emit("model_select", {
        model: { provider: "openai", id: "gpt-reenabled" },
        source: "set",
      });
      assert.ok(lineCount(temp.logFile) > afterEnable);
    } finally {
      temp.cleanup();
    }
  });

  it("warns when a toggle cannot be saved, while applying it for this session", async () => {
    const temp = withHome();
    try {
      const runtime = await createRuntime({ selections: ["Disable model-debugger (currently enabled)"] });
      mkdirSync(temp.stateFile);
      await runtime.command("model-debugger");
      assert.match(runtime.notifications.at(-1).message, /Could not save.*current session only/);
      assert.equal(runtime.notifications.at(-1).level, "warning");
      assert.equal(existsSync(temp.stateFile), true);
      assert.equal(read(temp.stateFile), "");
      await runtime.command("model-debugger");
      assert.match(runtime.selects.at(-1).options[0], /Enable model-debugger \(currently disabled\)/);
    } finally {
      temp.cleanup();
    }
  });

  it("keeps the non-TUI bare command read-only and preserves the debug command set", async () => {
    const temp = withHome();
    try {
      const runtime = await createRuntime({ mode: "rpc", selections: ["Disable model-debugger (currently enabled)"] });
      for (const name of COMMAND_NAMES) assert.equal(runtime.commands.has(name), true, `${name} is registered`);

      await runtime.command("model-debugger");
      assert.equal(runtime.selects.length, 0);
      assert.equal(existsSync(temp.stateFile), false);
      assert.match(runtime.notifications.at(-1).message, /Model Debugger: enabled/);
      assert.match(runtime.notifications.at(-1).message, /Log summary:/);

      const before = lineCount(temp.logFile);
      await runtime.emit("model_select", {
        model: { provider: "openai", id: "gpt-rpc" },
        source: "set",
      });
      assert.ok(lineCount(temp.logFile) > before, "bare non-TUI status must not disable logging");

      await runtime.command("debug-toggle", "off");
      assert.equal(read(temp.stateFile), "disabled");
      await runtime.command("debug-toggle", "on");
      assert.equal(read(temp.stateFile), "enabled");
    } finally {
      temp.cleanup();
    }
  });

  it("loads the persisted debug-toggle state in a fresh extension runtime", async () => {
    const temp = withHome();
    try {
      const first = await createRuntime();
      await first.command("debug-toggle", "off");
      assert.equal(read(temp.stateFile), "disabled");

      const second = await createRuntime({ mode: "rpc" });
      const before = lineCount(temp.logFile);
      await second.emit("model_select", {
        model: { provider: "openai", id: "gpt-disabled-runtime" },
        source: "set",
      });
      assert.equal(lineCount(temp.logFile), before);
    } finally {
      temp.cleanup();
    }
  });

  it("prints the same read-only summary in a no-UI non-TUI fallback", async () => {
    const temp = withHome();
    const output = [];
    const originalLog = console.log;
    console.log = (...args) => output.push(args.join(" "));
    try {
      const runtime = await createRuntime({ mode: "print", hasUI: false });
      await runtime.command("model-debugger");
      assert.equal(runtime.selects.length, 0);
      assert.equal(existsSync(temp.stateFile), false);
      assert.match(output.at(-1), /Model Debugger: enabled/);
      assert.match(output.at(-1), /Log summary:/);
    } finally {
      console.log = originalLog;
      temp.cleanup();
    }
  });

  it("does not open a menu when mode is absent or TUI has no UI", async () => {
    const temp = withHome();
    const originalLog = console.log;
    console.log = () => {};
    try {
      for (const options of [{ omitMode: true }, { mode: "tui", hasUI: false }]) {
        const runtime = await createRuntime(options);
        await runtime.command("model-debugger");
        assert.equal(runtime.selects.length, 0);
        assert.equal(existsSync(temp.stateFile), false);
      }
    } finally {
      console.log = originalLog;
      temp.cleanup();
    }
  });
});
