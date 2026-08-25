import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const {
	appendCapped,
	appendStdout,
	buildGrokArgs,
	buildPrompt,
	effortArg,
	OUTPUT_LIMIT,
	parseGrokCliOutput,
	parseToolCalls,
	smokeTestCommand,
	splitResponse,
	STDOUT_LIMIT,
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

test("splitResponse preserves prose surrounding tool-call markers", () => {
	const { prose, calls } = splitResponse(
		'Let me check that file.\n<pi_tool_call>{"name":"read","arguments":{"path":"/a"}}</pi_tool_call>\nReading now.',
	);
	assert.equal(prose, "Let me check that file.\n\nReading now.");
	assert.match(prose, /Let me check that file\./);
	assert.match(prose, /Reading now\./);
	assert.ok(!prose.includes("<pi_tool_call>"));
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], { name: "read", arguments: { path: "/a" } });

	const noProse = splitResponse('<pi_tool_call>{"name":"bash","arguments":{}}</pi_tool_call>');
	assert.equal(noProse.prose, "");
	assert.equal(noProse.calls.length, 1);
});

test("appendCapped keeps only the tail of chatty subprocess output", () => {
	assert.equal(appendCapped("", "hello"), "hello");
	assert.equal(appendCapped("abc", "de"), "abcde");
	assert.equal(appendCapped("a".repeat(OUTPUT_LIMIT), "TAIL"), ("a".repeat(OUTPUT_LIMIT) + "TAIL").slice(-OUTPUT_LIMIT));
	assert.equal(appendCapped("x".repeat(50_000), "y").length, OUTPUT_LIMIT);
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

test("appendStdout keeps JSON payloads larger than OUTPUT_LIMIT fully parseable", () => {
	const big = JSON.stringify({
		text: "x".repeat(OUTPUT_LIMIT + 5_000),
		usage: { input_tokens: 12, output_tokens: 34, reasoning_tokens: 2, total_tokens: 48 },
		total_cost_usd: 0.42,
	});
	assert.ok(big.length > OUTPUT_LIMIT);

	let acc = "";
	for (let i = 0; i < big.length; i += 1024) {
		acc = appendStdout(acc, big.slice(i, i + 1024));
	}
	assert.equal(acc.length, big.length);
	assert.ok(acc.startsWith("{"));

	const parsed = parseGrokCliOutput(acc);
	assert.equal(parsed.text.length, OUTPUT_LIMIT + 5_000);
	assert.equal(parsed.usage?.total_tokens, 48);
	assert.equal(parsed.total_cost_usd, 0.42);

	assert.throws(() => appendStdout("a".repeat(STDOUT_LIMIT), "overflow"), /more than/);
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
