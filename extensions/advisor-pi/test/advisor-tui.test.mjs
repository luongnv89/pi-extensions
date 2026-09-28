import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import advisorPiExtension, { defaultConfig } from "../dist/index.js";
import { loadPreferences } from "../dist/preferences.js";
import { buildMenuRows } from "../dist/config-ui.js";

const MODELS = [
  { provider: "openai-codex", id: "gpt-5.6-sol" },
  { provider: "groq", id: "llama-3.1-8b-instant" },
  { provider: "groq", id: "openai/gpt-oss-20b" },
];

function withAgentDir() {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const root = mkdtempSync(join(tmpdir(), "advisor-pi-tui-"));
  process.env.PI_CODING_AGENT_DIR = root;
  return {
    root,
    cleanup() {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function createRuntime({
  mode = "tui",
  hasUI = true,
  models = MODELS,
  availableModels = models,
  findOverride,
  flags = {},
  branch = [],
  selections = [],
  inputs = [],
  confirms = [],
} = {}) {
  const known = new Map(models.map((model) => [`${model.provider}/${model.id}`, model]));
  const handlers = new Map();
  const commands = new Map();
  const notices = [];
  const selects = [];
  const inputCalls = [];
  const confirmCalls = [];
  const entries = [];
  let activeTools = [];
  const api = {
    registerFlag() {},
    getFlag(name) { return Object.prototype.hasOwnProperty.call(flags, name) ? flags[name] : undefined; },
    registerTool() {},
    registerCommand(name, definition) { commands.set(name, definition.handler); },
    on(name, handler) { handlers.set(name, handler); },
    appendEntry(customType, data) { entries.push({ customType, data }); },
    getActiveTools() { return activeTools; },
    setActiveTools(next) { activeTools = next; },
  };
  advisorPiExtension(api);

  const context = {
    mode,
    hasUI,
    modelRegistry: {
      find(provider, modelId) {
        if (findOverride) return findOverride(provider, modelId, () => known.get(`${provider}/${modelId}`));
        return known.get(`${provider}/${modelId}`);
      },
      getAvailable() { return [...availableModels]; },
    },
    sessionManager: { getBranch: () => branch },
    ui: {
      async select(title, options) {
        selects.push({ title, options });
        return selections.shift();
      },
      async input(title, placeholder) {
        inputCalls.push({ title, placeholder });
        return inputs.shift();
      },
      async confirm(title, message) {
        confirmCalls.push({ title, message });
        return confirms.shift() ?? false;
      },
      notify(message, level) { notices.push({ message, level }); },
      setStatus() {},
      theme: { fg: (_color, text) => text },
    },
  };

  return {
    context,
    notices,
    selects,
    inputCalls,
    confirmCalls,
    entries,
    activeTools: () => activeTools,
    queue({ selections: nextSelections = [], inputs: nextInputs = [], confirms: nextConfirms = [] } = {}) {
      selections.push(...nextSelections);
      inputs.push(...nextInputs);
      confirms.push(...nextConfirms);
    },
    async start() { await handlers.get("session_start")?.({}, context); },
    async tree() { await handlers.get("session_tree")?.({}, context); },
    async command(args) { await commands.get("advisor-pi")(args, context); },
  };
}

function menuLabel(key, useCount = 0, config = defaultConfig()) {
  return buildMenuRows(config, useCount).find((row) => row.key === key).label;
}

describe("advisor-pi TUI settings", { concurrency: false }, () => {
  it("edits every menu setting through existing command validation and persists immediately", async () => {
    const temp = withAgentDir();
    try {
      const runtime = createRuntime({
        selections: [
          menuLabel("enabled"),
          "disabled",
          menuLabel("model"),
          menuLabel("thinking"),
          "medium",
          menuLabel("max-uses"),
          menuLabel("max-transcript-chars"),
          menuLabel("cache"),
          "long",
          "Close",
        ],
        inputs: ["groq/llama-3.1-8b-instant", "9", "9000"],
        confirms: [true],
      });
      await runtime.start();
      await runtime.command("");

      assert.deepEqual(loadPreferences(temp.root), {
        enabled: false,
        provider: "groq",
        modelId: "llama-3.1-8b-instant",
        thinkingLevel: "medium",
        maxUses: 9,
        maxTranscriptChars: 9000,
        cacheRetention: "long",
      });
      assert.deepEqual(runtime.activeTools(), []);
      assert.equal(runtime.confirmCalls.length, 1);
      assert.equal(runtime.entries.length, 6);
    } finally {
      temp.cleanup();
    }
  });

  it("persists each accepted edit immediately and reloads it in a fresh runtime", async () => {
    const temp = withAgentDir();
    try {
      const runtime = createRuntime();
      await runtime.start();

      runtime.queue({ selections: [menuLabel("enabled"), "disabled", "Close"], confirms: [true] });
      await runtime.command("");
      assert.deepEqual(loadPreferences(temp.root), { enabled: false });
      assert.equal(runtime.entries.length, 1);

      runtime.queue({ selections: [menuLabel("model"), "Close"], inputs: ["groq/llama-3.1-8b-instant"] });
      await runtime.command("");
      assert.deepEqual(loadPreferences(temp.root), {
        enabled: false,
        provider: "groq",
        modelId: "llama-3.1-8b-instant",
      });
      assert.equal(runtime.entries.length, 2);

      runtime.queue({ selections: [menuLabel("thinking"), "medium", "Close"] });
      await runtime.command("");
      assert.equal(loadPreferences(temp.root).thinkingLevel, "medium");
      assert.equal(runtime.entries.length, 3);

      runtime.queue({ selections: [menuLabel("max-uses"), "Close"], inputs: ["9"] });
      await runtime.command("");
      assert.equal(loadPreferences(temp.root).maxUses, 9);
      assert.equal(runtime.entries.length, 4);

      runtime.queue({ selections: [menuLabel("max-transcript-chars"), "Close"], inputs: ["9000"] });
      await runtime.command("");
      assert.equal(loadPreferences(temp.root).maxTranscriptChars, 9000);
      assert.equal(runtime.entries.length, 5);

      runtime.queue({ selections: [menuLabel("cache"), "long", "Close"] });
      await runtime.command("");
      assert.equal(loadPreferences(temp.root).cacheRetention, "long");
      assert.equal(runtime.entries.length, 6);

      const fresh = createRuntime();
      await fresh.start();
      await fresh.command("status");
      assert.match(fresh.notices.at(-1).message, /advisor-pi disabled/);
      assert.match(fresh.notices.at(-1).message, /model: groq\/llama-3\.1-8b-instant \(available\)/);
      assert.match(fresh.notices.at(-1).message, /thinking: medium/);
      assert.match(fresh.notices.at(-1).message, /uses: 0\/9/);
      assert.match(fresh.notices.at(-1).message, /transcript: max 9000 chars/);
      assert.match(fresh.notices.at(-1).message, /cache: long/);
      assert.equal(fresh.entries.length, 0, "loading durable settings must not append session state");
    } finally {
      temp.cleanup();
    }
  });

  it("does not mutate on invalid numeric, enum, or typed model input", async () => {
    const temp = withAgentDir();
    try {
      const runtime = createRuntime();
      await runtime.start();

      runtime.queue({ selections: [menuLabel("max-uses"), "Close"], inputs: ["not-a-number"] });
      await runtime.command("");
      assert.deepEqual(loadPreferences(temp.root), {});

      runtime.queue({ selections: [menuLabel("thinking"), "ultra", "Close"] });
      await runtime.command("");
      assert.deepEqual(loadPreferences(temp.root), {});

      runtime.queue({ selections: [menuLabel("cache"), "forever", "Close"] });
      await runtime.command("");
      assert.deepEqual(loadPreferences(temp.root), {});

      const invalidModel = "customer@example.com/sk_live_pi-advisor-private-key";
      runtime.queue({ selections: [menuLabel("model"), "Close"], inputs: [invalidModel] });
      await runtime.command("");
      assert.deepEqual(loadPreferences(temp.root), {});
      assert.match(runtime.notices.at(-1).message, /Advisor model not found/);
      assert.ok(!runtime.notices.at(-1).message.includes(invalidModel));

      const malformedModel = "sk_live_pi-advisor-malformed";
      runtime.queue({ selections: [menuLabel("model"), "Close"], inputs: [malformedModel] });
      await runtime.command("");
      assert.deepEqual(loadPreferences(temp.root), {});
      assert.match(runtime.notices.at(-1).message, /Expected provider\/model/);
      assert.ok(!runtime.notices.at(-1).message.includes(malformedModel));
      await runtime.command("status");
      assert.match(runtime.notices.at(-1).message, /model: openai-codex\/gpt-5\.6-sol \(available\)/);
      assert.match(runtime.notices.at(-1).message, /thinking: high/);
      assert.match(runtime.notices.at(-1).message, /uses: 0\/5/);
      assert.match(runtime.notices.at(-1).message, /cache: short/);
      assert.equal(runtime.entries.length, 0);
    } finally {
      temp.cleanup();
    }
  });

  it("leaves state unchanged when nested dialogs receive Escape", async () => {
    const temp = withAgentDir();
    try {
      const runtime = createRuntime();
      await runtime.start();

      const escapedDialogs = [
        { selections: [menuLabel("enabled"), undefined] },
        { selections: [menuLabel("model"), undefined] },
        { selections: [menuLabel("model")], inputs: [undefined] },
        { selections: [menuLabel("max-uses")], inputs: [undefined] },
        { selections: [menuLabel("thinking"), undefined] },
        { selections: [menuLabel("cache"), undefined] },
        { selections: [undefined] },
      ];
      for (const dialog of escapedDialogs) {
        runtime.queue(dialog);
        await runtime.command("");
        assert.deepEqual(loadPreferences(temp.root), {});
        assert.equal(runtime.entries.length, 0);
      }
    } finally {
      temp.cleanup();
    }
  });

  it("does not mutate when the enabled confirmation is cancelled", async () => {
    const temp = withAgentDir();
    try {
      const runtime = createRuntime({
        selections: [menuLabel("enabled"), "disabled", "Close"],
        confirms: [false],
      });
      await runtime.start();
      await runtime.command("");

      assert.deepEqual(loadPreferences(temp.root), {});
      assert.deepEqual(runtime.activeTools(), ["advisor"]);
      assert.equal(runtime.confirmCalls.length, 1);
      assert.equal(runtime.entries.length, 0);
    } finally {
      temp.cleanup();
    }
  });

  it("accepts and persists a valid manually typed model", async () => {
    const temp = withAgentDir();
    try {
      const typedModel = { provider: "custom", id: "typed-advisor" };
      const runtime = createRuntime({
        models: [...MODELS, typedModel],
        availableModels: [MODELS[0]],
        selections: [menuLabel("model"), "Close"],
        inputs: ["custom/typed-advisor"],
      });
      await runtime.start();
      await runtime.command("");

      assert.deepEqual(loadPreferences(temp.root), { provider: "custom", modelId: "typed-advisor" });
      assert.deepEqual(runtime.inputCalls, [{ title: "Advisor model", placeholder: "provider/model" }]);
      assert.equal(runtime.selects.length, 2);
      assert.equal(runtime.entries.length, 1);
    } finally {
      temp.cleanup();
    }
  });

  it("keeps current and registry identifiers out of TUI options and invalid-input notices", async () => {
    const temp = withAgentDir();
    try {
      const currentModel = { provider: "customer@example.com", id: "sk_live_current_advisor_key" };
      const registryModel = { provider: "registry@example.com", id: "sk_live_registry_advisor_key" };
      const malformedModel = "sk_live_malformed_advisor_input";
      const invalidModel = "untrusted@example.com/sk_live_invalid_advisor_input";
      const branch = [{
        type: "custom",
        customType: "advisor-pi-state",
        data: {
          version: 1,
          config: {
            ...defaultConfig(),
            provider: currentModel.provider,
            modelId: currentModel.id,
          },
          useCount: 0,
        },
      }];
      const runtime = createRuntime({
        models: [...MODELS, currentModel, registryModel],
        availableModels: [registryModel],
        branch,
        selections: ["Close"],
      });
      await runtime.start();

      const assertNoSecretsInOptions = () => {
        const options = runtime.selects.flatMap((select) => select.options);
        for (const identifier of [
          currentModel.provider,
          currentModel.id,
          registryModel.provider,
          registryModel.id,
        ]) {
          assert.ok(options.every((option) => !option.includes(identifier)), `option exposed ${identifier}`);
        }
      };
      const assertNoSecretsInNotices = () => {
        for (const { message } of runtime.notices) {
          for (const identifier of [
            currentModel.provider,
            currentModel.id,
            registryModel.provider,
            registryModel.id,
            malformedModel,
            invalidModel,
          ]) {
            assert.ok(!message.includes(identifier), `notice exposed ${identifier}: ${message}`);
          }
        }
      };

      await runtime.command("");
      assertNoSecretsInOptions();

      runtime.queue({ selections: [menuLabel("model")], inputs: [undefined] });
      await runtime.command("");
      assert.deepEqual(loadPreferences(temp.root), {});
      assert.equal(runtime.entries.length, 0);
      assertNoSecretsInOptions();

      runtime.queue({ selections: [menuLabel("model"), "Close"], inputs: [malformedModel] });
      await runtime.command("");
      assert.deepEqual(loadPreferences(temp.root), {});
      assert.equal(runtime.entries.length, 0);
      assert.deepEqual(runtime.notices.at(-1), { message: "Expected provider/model", level: "error" });
      assertNoSecretsInOptions();
      assertNoSecretsInNotices();

      runtime.queue({ selections: [menuLabel("model"), "Close"], inputs: [invalidModel] });
      await runtime.command("");
      assert.deepEqual(loadPreferences(temp.root), {});
      assert.equal(runtime.entries.length, 0);
      assert.deepEqual(runtime.notices.at(-1), { message: "Advisor model not found", level: "error" });
      assertNoSecretsInOptions();
      assertNoSecretsInNotices();
    } finally {
      temp.cleanup();
    }
  });

  it("redacts a model error when the second registry lookup misses", async () => {
    const temp = withAgentDir();
    try {
      const flakyModel = { provider: "flaky@example.com", id: "sk_live_flaky_advisor_key" };
      let lookupCount = 0;
      const runtime = createRuntime({
        models: [...MODELS, flakyModel],
        findOverride(provider, modelId, fallback) {
          if (provider === flakyModel.provider && modelId === flakyModel.id) {
            lookupCount += 1;
            return lookupCount === 1 ? flakyModel : undefined;
          }
          return fallback();
        },
        selections: [menuLabel("model"), "Close"],
        inputs: [`${flakyModel.provider}/${flakyModel.id}`],
      });
      await runtime.start();
      lookupCount = 0;
      await runtime.command("");

      assert.equal(lookupCount, 2, "menu validation and applyCommand should perform two lookups");
      assert.deepEqual(loadPreferences(temp.root), {});
      assert.equal(runtime.entries.length, 0);
      assert.deepEqual(runtime.notices.at(-1), { message: "Advisor model not found", level: "error" });
      assert.ok(!runtime.notices.at(-1).message.includes(flakyModel.provider));
      assert.ok(!runtime.notices.at(-1).message.includes(flakyModel.id));
    } finally {
      temp.cleanup();
    }
  });

  it("confirms reset, clears the branch count, and preserves settings", async () => {
    const temp = withAgentDir();
    try {
      const branchConfig = {
        ...defaultConfig(),
        enabled: true,
        provider: "groq",
        modelId: "llama-3.1-8b-instant",
        thinkingLevel: "medium",
        maxUses: 9,
        maxTranscriptChars: 9000,
        cacheRetention: "long",
      };
      const runtime = createRuntime({
        branch: [{
          type: "custom",
          customType: "advisor-pi-state",
          data: { version: 1, config: branchConfig, useCount: 3 },
        }],
        selections: [menuLabel("reset", 3), "Close"],
        confirms: [true],
      });
      await runtime.start();
      await runtime.command("");

      assert.match(runtime.selects[0].options.find((row) => row.startsWith("Reset use count")), /3 used/);
      assert.equal(runtime.confirmCalls.length, 1);
      assert.equal(runtime.entries.length, 1);
      assert.equal(runtime.entries[0].data.useCount, 0);
      assert.deepEqual(loadPreferences(temp.root), {});

      await runtime.command("status");
      assert.match(runtime.notices.at(-1).message, /advisor-pi enabled/);
      assert.match(runtime.notices.at(-1).message, /model: groq\/llama-3\.1-8b-instant \(available\)/);
      assert.match(runtime.notices.at(-1).message, /thinking: medium/);
      assert.match(runtime.notices.at(-1).message, /uses: 0\/9/);
      assert.match(runtime.notices.at(-1).message, /transcript: max 9000 chars/);
      assert.match(runtime.notices.at(-1).message, /cache: long/);
    } finally {
      temp.cleanup();
    }
  });

  it("does not mutate when reset is cancelled or already at zero", async () => {
    const temp = withAgentDir();
    try {
      const branch = [{
        type: "custom",
        customType: "advisor-pi-state",
        data: { version: 1, config: defaultConfig(), useCount: 2 },
      }];
      const cancelled = createRuntime({
        branch,
        selections: [menuLabel("reset", 2), "Close"],
        confirms: [false],
      });
      await cancelled.start();
      await cancelled.command("");
      assert.equal(cancelled.confirmCalls.length, 1);
      assert.equal(cancelled.entries.length, 0);
      assert.deepEqual(loadPreferences(temp.root), {});
      await cancelled.command("status");
      assert.match(cancelled.notices.at(-1).message, /uses: 2\/5/);

      const zero = createRuntime({ selections: [menuLabel("reset", 0), "Close"] });
      await zero.start();
      await zero.command("");
      assert.equal(zero.confirmCalls.length, 0, "zero uses should be a no-op without confirmation");
      assert.equal(zero.entries.length, 0);
      await zero.command("status");
      assert.match(zero.notices.at(-1).message, /uses: 0\/5/);
      assert.deepEqual(loadPreferences(temp.root), {});
    } finally {
      temp.cleanup();
    }
  });

  it("applies startup flags after branch replay without persisting them", async () => {
    const temp = withAgentDir();
    try {
      const branchModel = { provider: "branch", id: "branch-advisor" };
      const flagModel = { provider: "flag", id: "flag-advisor" };
      const models = [...MODELS, branchModel, flagModel];
      const branch = [{
        type: "custom",
        customType: "advisor-pi-state",
        data: {
          version: 1,
          config: {
            ...defaultConfig(),
            enabled: true,
            provider: branchModel.provider,
            modelId: branchModel.id,
            thinkingLevel: "high",
            maxUses: 99,
            maxTranscriptChars: 321,
            cacheRetention: "long",
          },
          useCount: 4,
        },
      }];
      const runtime = createRuntime({
        models,
        branch,
        flags: {
          "advisor-enabled": false,
          "advisor-model": "flag/flag-advisor",
          "advisor-thinking": "low",
          "advisor-max-uses": "6",
          "advisor-max-transcript-chars": "700",
          "advisor-cache": "none",
        },
      });
      await runtime.start();
      await runtime.command("status");
      assert.match(runtime.notices.at(-1).message, /advisor-pi disabled/);
      assert.match(runtime.notices.at(-1).message, /model: flag\/flag-advisor \(available\)/);
      assert.match(runtime.notices.at(-1).message, /thinking: low/);
      assert.match(runtime.notices.at(-1).message, /uses: 4\/6/);
      assert.match(runtime.notices.at(-1).message, /transcript: max 700 chars/);
      assert.match(runtime.notices.at(-1).message, /cache: none/);

      runtime.queue({ selections: ["Close"] });
      await runtime.command("");
      const menu = runtime.selects[0].options;
      assert.ok(menu.some((row) => /Advisor enabled\s+disabled$/.test(row)));
      assert.ok(menu.some((row) => /Advisor model\s+configured \(use \/advisor-pi status for ID\)$/.test(row)));
      assert.ok(menu.every((row) => !row.includes("flag/flag-advisor")));
      assert.ok(menu.some((row) => /Advisor thinking\s+low$/.test(row)));
      assert.ok(menu.some((row) => /Max advisor uses\s+6$/.test(row)));
      assert.ok(menu.some((row) => /Max transcript chars\s+700$/.test(row)));
      assert.ok(menu.some((row) => /Cache retention\s+none$/.test(row)));
      assert.deepEqual(loadPreferences(temp.root), {});
      assert.equal(runtime.entries.length, 0);
    } finally {
      temp.cleanup();
    }
  });

  it("keeps explicit commands unchanged while bare /advisor-pi opens the menu", async () => {
    const temp = withAgentDir();
    try {
      const runtime = createRuntime({
        branch: [{
          type: "custom",
          customType: "advisor-pi-state",
          data: { version: 1, config: defaultConfig(), useCount: 3 },
        }],
      });
      await runtime.start();

      await runtime.command("status");
      assert.match(runtime.notices.at(-1).message, /uses: 3\/5/);
      assert.equal(runtime.selects.length, 0);

      await runtime.command("disable");
      assert.match(runtime.notices.at(-1).message, /^advisor-pi disabled/);
      await runtime.command("enable");
      assert.match(runtime.notices.at(-1).message, /^advisor-pi enabled/);
      await runtime.command("model groq/llama-3.1-8b-instant");
      assert.match(runtime.notices.at(-1).message, /model set to groq\/llama-3\.1-8b-instant/);
      await runtime.command("thinking low");
      assert.match(runtime.notices.at(-1).message, /thinking level set to low/);
      await runtime.command("max-uses 7");
      assert.match(runtime.notices.at(-1).message, /max uses set to 7/);
      await runtime.command("max-transcript-chars 700");
      assert.match(runtime.notices.at(-1).message, /max transcript chars set to 700/);
      await runtime.command("cache none");
      assert.match(runtime.notices.at(-1).message, /cache set to none/);
      await runtime.command("reset");
      assert.match(runtime.notices.at(-1).message, /use count reset/);
      await runtime.command("status");
      assert.match(runtime.notices.at(-1).message, /uses: 0\/7/);
      assert.equal(runtime.selects.length, 0, "explicit commands must not open the TUI menu");

      assert.deepEqual(loadPreferences(temp.root), {
        enabled: true,
        provider: "groq",
        modelId: "llama-3.1-8b-instant",
        thinkingLevel: "low",
        maxUses: 7,
        maxTranscriptChars: 700,
        cacheRetention: "none",
      });
      assert.equal(runtime.entries.length, 8);
    } finally {
      temp.cleanup();
    }
  });

  it("keeps bare /advisor-pi as status outside the terminal TUI", async () => {
    const temp = withAgentDir();
    try {
      for (const runtime of [createRuntime({ mode: "rpc" }), createRuntime({ mode: "tui", hasUI: false })]) {
        await runtime.start();
        await runtime.command("");
        assert.equal(runtime.selects.length, 0);
        assert.match(runtime.notices.at(-1).message, /^advisor-pi enabled/);
      }
      assert.deepEqual(loadPreferences(temp.root), {});
    } finally {
      temp.cleanup();
    }
  });
});
