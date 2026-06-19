import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { fixOpenAIChatPayload, fixToolSchema } = await import(
	`file://${join(extRoot, "src/fm-tools.ts")}`
);

test("fixToolSchema flattens nested object to string", () => {
	const { schema } = fixToolSchema({
		type: "object",
		properties: {
			path: { type: "string" },
			edits: {
				type: "array",
				items: { type: "object", properties: { oldText: { type: "string" } } },
			},
		},
		required: ["path"],
	});
	assert.equal(schema.properties.edits.type, "string");
	assert.deepEqual(schema.required, ["path"]);
});

test("fixOpenAIChatPayload rewrites tools array", () => {
	const { payload } = fixOpenAIChatPayload({
		model: "system",
		messages: [],
		tools: [
			{
				type: "function",
				function: {
					name: "edit",
					parameters: {
						type: "object",
						properties: {
							edits: { type: "array", items: { type: "object", properties: { x: { type: "string" } } } },
						},
						required: ["edits"],
					},
				},
			},
		],
	});
	const params = payload.tools[0].function.parameters;
	assert.equal(params.properties.edits.type, "string");
});