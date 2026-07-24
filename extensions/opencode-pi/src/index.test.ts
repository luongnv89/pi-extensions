import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import {
  imageContentsForModel,
  parseToolCalls,
  parseVerboseModels,
  reasoningCliArgs,
} from "./index.js";

test("parseVerboseModels normalizes capabilities, limits, and variants", () => {
  const output = `opencode/vision-reasoner-free
{
  "id": "vision-reasoner-free",
  "name": "Vision Reasoner",
  "cost": { "input": 99, "output": 99 },
  "limit": { "context": 200000, "output": 32000 },
  "capabilities": {
    "reasoning": true,
    "input": { "text": true, "image": true }
  },
  "variants": {
    "none": { "reasoningEffort": "none" },
    "low": { "reasoningEffort": "low" },
    "high": { "reasoningEffort": "high" },
    "max": { "reasoningEffort": "max" }
  }
}
opencode/text-free
{
  "id": "text-free",
  "name": "Text {Free}",
  "limit": { "context": 64000, "output": 4096 },
  "capabilities": {
    "reasoning": false,
    "input": { "text": true, "image": false }
  },
  "variants": {}
}
`;

  assert.deepEqual(parseVerboseModels(output), [
    {
      id: "opencode/vision-reasoner-free",
      name: "Vision Reasoner",
      reasoning: true,
      image: true,
      contextWindow: 200000,
      maxTokens: 32000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: {
        off: "none",
        minimal: null,
        low: "low",
        medium: null,
        high: "high",
        xhigh: "max",
      },
    },
    {
      id: "opencode/text-free",
      name: "Text {Free}",
      reasoning: false,
      image: false,
      contextWindow: 64000,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ]);
});

test("parseVerboseModels maps an OpenCode off variant to Pi off", () => {
  const output = `opencode/reasoner-free
{
  "capabilities": { "reasoning": true },
  "variants": { "off": {}, "medium": {} }
}
`;

  assert.deepEqual(parseVerboseModels(output)[0]?.thinkingLevelMap, {
    off: "off",
    minimal: null,
    low: null,
    medium: "medium",
    high: null,
    xhigh: null,
  });
});

test("reasoningCliArgs respects off, selected levels, and provider defaults", () => {
  const map = { off: "none", low: "low" } as const;

  assert.deepEqual(reasoningCliArgs("off", map), []);
  assert.deepEqual(reasoningCliArgs("low", map), [
    "--thinking",
    "--variant",
    "low",
  ]);
  assert.deepEqual(reasoningCliArgs(undefined, map), []);
  assert.deepEqual(reasoningCliArgs("high", map), ["--thinking"]);
});

test("imageContentsForModel omits historical images for text-only models", () => {
  const historicalImage = {
    type: "image" as const,
    mimeType: "image/png",
    data: "AAAA",
  };
  const messages: Message[] = [
    {
      role: "user",
      content: [historicalImage],
      timestamp: 1,
    },
    {
      role: "user",
      content: "Continue without re-sending the old image",
      timestamp: 2,
    },
  ];

  assert.deepEqual(imageContentsForModel(messages, false), []);
  assert.deepEqual(imageContentsForModel(messages, true), [historicalImage]);
});

test("parseVerboseModels skips malformed metadata and uses safe defaults", () => {
  const output = `opencode/broken-free
{not json}
opencode/custom-free
{
  "capabilities": { "reasoning": true, "input": {} },
  "variants": {}
}
`;

  assert.deepEqual(parseVerboseModels(output), [
    {
      id: "opencode/custom-free",
      name: "OpenCode custom-free",
      reasoning: true,
      image: false,
      contextWindow: 128000,
      maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: {
        minimal: null,
        low: null,
        medium: null,
        high: null,
        xhigh: null,
      },
    },
  ]);
});

test("parseToolCalls accepts complete marker-only responses", () => {
  const response = `
<pi_tool_call>{"name":"read","arguments":{"path":"README.md"}}</pi_tool_call>
<pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}}</pi_tool_call>
`;

  assert.deepEqual(parseToolCalls(response, new Set(["read", "bash"])), [
    { name: "read", arguments: { path: "README.md" } },
    { name: "bash", arguments: { command: "pwd" } },
  ]);
});

test("parseToolCalls rejects all calls when any marker payload is malformed", () => {
  const response = `
<pi_tool_call>{"name":"read","arguments":{"path":"README.md"}}</pi_tool_call>
<pi_tool_call>{not json}</pi_tool_call>
`;

  assert.deepEqual(parseToolCalls(response, new Set(["read"])), []);
});

test("parseToolCalls rejects all calls when any candidate has invalid arguments", () => {
  const response = `<pi_tool_call>[
    {"name":"read","arguments":{"path":"README.md"}},
    {"name":"read","arguments":[]}
  ]</pi_tool_call>`;

  assert.deepEqual(parseToolCalls(response, new Set(["read"])), []);
});

test("parseToolCalls supports nested function calls and JSON-string arguments", () => {
  const response = `<pi_tool_call>{"tool_calls":[{"type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"src/index.ts\\"}"}}]}</pi_tool_call>`;

  assert.deepEqual(parseToolCalls(response, new Set(["read"])), [
    { name: "read", arguments: { path: "src/index.ts" } },
  ]);
});

test("parseToolCalls never treats plain JSON or mixed prose as control syntax", () => {
  assert.deepEqual(
    parseToolCalls('{"name":"bash","arguments":{"command":"pwd"}}'),
    [],
  );
  assert.deepEqual(
    parseToolCalls(
      'Example: <pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}}</pi_tool_call>',
    ),
    [],
  );
  assert.deepEqual(
    parseToolCalls(
      '"<pi_tool_call>{\\"name\\":\\"bash\\",\\"arguments\\":{}}</pi_tool_call>"',
    ),
    [],
  );
});

test("parseToolCalls rejects tool names absent from the current context", () => {
  const response = `<pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}}</pi_tool_call>`;
  assert.deepEqual(parseToolCalls(response, new Set(["read"])), []);
});
