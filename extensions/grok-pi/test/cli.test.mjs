import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const {
	buildGrokArgs,
	buildPrompt,
	effortArg,
	parseGrokCliOutput,
	parseToolCalls,
	smokeTestCommand,
	stripToolMarkers,
} = await import(`file://${join(extRoot, "src/cli.ts")}`);

test("buildGrokArgs disables Grok's own tools and pins the model", () => {
	const args = buildGrokArgs("grok-4.6", "high", "hello");

	const toolsIdx = args.indexOf("--tools");
	assert.equal(args[toolsIdx + 1], "");
	assert.ok(args.includes("--disable-web-search"));
	assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
	assert.equal(args[args.indexOf("--model") + 1], "grok-4.6");
	assert.equal(args[args.indexOf("--effort") + 1], "high");
	assert.equal(args[args.indexOf("--single") + 1], "hello");
	assert.ok(!args.includes("--no-session-persistence"), "flag does not exist in the grok CLI");
});

test("effortArg maps Pi thinking levels to grok efforts", () => {
	assert.equal(effortArg(undefined), undefined);
	assert.equal(effortArg("off"), undefined);
	assert.equal(effortArg("minimal"), "low");
	assert.equal(effortArg("medium"), "medium");
	assert.equal(effortArg("xhigh"), "xhigh");
	assert.equal(effortArg("max"), "xhigh");
});

test("parseToolCalls extracts single, multiple, and fenced JSON calls", () => {
	assert.deepEqual(parseToolCalls("no calls here"), []);

	const one = parseToolCalls('prefix <pi_tool_call>{"name":"read","arguments":{"path":"/a"}}</pi_tool_call>');
	assert.equal(one.length, 1);
	assert.deepEqual(one[0], { name: "read", arguments: { path: "/a" } });

	const many = parseToolCalls(
		'<pi_tool_call>[{"name":"bash","arguments":{}},{"name":"read","args":{"path":"/b"}}]</pi_tool_call>',
	);
	assert.equal(many.length, 2);
	assert.equal(many[1].name, "read");
	assert.deepEqual(many[1].arguments, { path: "/b" });

	const withArgsKey = parseToolCalls('<pi_tool_call>{"tool":"edit","input":{"path":"/c"}}</pi_tool_call>');
	assert.deepEqual(withArgsKey, [{ name: "edit", arguments: { path: "/c" } }]);
});

test("stripToolMarkers removes call blocks from display text", () => {
	assert.equal(
		stripToolMarkers("before<pi_tool_call>{}</pi_tool_call> after"),
		"before after",
	);
});

test("parseGrokCliOutput reads grok --single --output-format json payloads", () => {
	const sample = JSON.stringify({
		text: "OK",
		stopReason: "end_turn",
		sessionId: "01a03a99-85d4-73c2-b7da-b830c41d2afa",
		usage: {
			input_tokens: 21011,
			cache_read_input_tokens: 2944,
			cache_creation_input_tokens: 0,
			output_tokens: 29,
			reasoning_tokens: 24,
			total_tokens: 23984,
		},
		num_turns: 1,
		total_cost_usd: 0.014646928,
	});

	const parsed = parseGrokCliOutput(sample);
	assert.equal(parsed.text, "OK");
	assert.equal(parsed.usage?.input_tokens, 21011);
	assert.equal(parsed.usage?.reasoning_tokens, 24);
	assert.equal(parsed.total_cost_usd, 0.014646928);

	const fallback = parseGrokCliOutput("plain text response");
	assert.equal(fallback.text, "plain text response");
});

test("buildPrompt embeds system prompt, tools, and transcript", () => {
	const prompt = buildPrompt({
		systemPrompt: "Be terse.",
		messages: [
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "calling" },
					{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/x" } },
				],
			},
			{ role: "toolResult", toolName: "read", toolCallId: "t1", isError: false, content: "file body" },
		],
		tools: [{ name: "read", description: "Read a file", parameters: {} }],
	});

	assert.match(prompt, /Pi\/Grok CLI bridge instructions/);
	assert.match(prompt, /--tools ""/);
	assert.match(prompt, /# Pi system prompt\n\nBe terse\./);
	assert.match(prompt, /"name": "read"/);
	assert.match(prompt, /USER:\nhi/);
	assert.match(prompt, /<pi_tool_call>/);
	assert.match(prompt, /PI TOOL RESULT \(read, id=t1, isError=false\):/);
	assert.match(prompt, /Now produce the next assistant message for Pi\./);
});

test("smokeTestCommand mirrors buildGrokArgs flags", () => {
	const cmd = smokeTestCommand("grok", "grok-4.5");
	for (const flag of ["--single", '--tools ""', "--disable-web-search", "--permission-mode dontAsk", "--output-format json"]) {
		assert.ok(cmd.includes(flag), `missing ${flag}`);
	}
});
