/**
 * Tool schema flattening for Apple fm serve (from gregbarbosa/fm-proxy, MIT).
 * fm serve rejects nested JSON Schema — Pi tools must be simplified in-flight.
 */

const DECORATIVE = [
	"title",
	"examples",
	"default",
	"$schema",
	"$id",
	"$comment",
	"readOnly",
	"writeOnly",
];

const STRIP_KEYS = new Set([
	"anyOf",
	"allOf",
	"oneOf",
	"if",
	"then",
	"else",
	"not",
	"$defs",
	"definitions",
	"$ref",
	"patternProperties",
	"description",
	...DECORATIVE,
]);

const EMBED_STRIP_KEYS = new Set(["description", "additionalProperties", ...DECORATIVE]);

type JsonSchema = Record<string, unknown>;

function flattenComposite(prop: JsonSchema, key: "anyOf" | "oneOf" | "allOf", mergeAll: boolean): JsonSchema {
	const subs = (prop[key] as JsonSchema[] | undefined) ?? [];
	let merged: JsonSchema;
	if (mergeAll) {
		merged = {};
		for (const sub of subs) {
			if (sub && typeof sub === "object") Object.assign(merged, sub);
		}
		for (const [k, v] of Object.entries(prop)) {
			if (k !== key) merged[k] = v;
		}
	} else {
		const base =
			subs.find((s) => s && typeof s === "object" && s.type) ||
			subs[0] ||
			({ type: "string" } as JsonSchema);
		merged = { ...base };
		for (const [k, v] of Object.entries(prop)) {
			if (k !== key && !(k in merged)) merged[k] = v;
		}
	}
	return simplifyProperty(merged) as JsonSchema;
}

export function simplifyProperty(prop: unknown): unknown {
	if (!prop || typeof prop !== "object") return prop;
	const p = prop as JsonSchema;

	if (p.anyOf) return flattenComposite(p, "anyOf", false);
	if (p.oneOf) return flattenComposite(p, "oneOf", false);
	if (p.allOf) return flattenComposite(p, "allOf", true);

	if (p.type === "object" || p.properties) {
		return { type: "string" };
	}

	if (p.type === "array") {
		const result: JsonSchema = { type: "array" };
		if (p.items) result.items = simplifyProperty(p.items);
		if (typeof p.description === "string") result.description = p.description;
		return result;
	}

	const result: JsonSchema = {};
	for (const [k, v] of Object.entries(p)) {
		if (!STRIP_KEYS.has(k)) result[k] = v;
	}
	return result;
}

function needsJsonRoundTrip(prop: unknown): boolean {
	if (!prop || typeof prop !== "object") return false;
	const p = prop as JsonSchema;
	if (p.type === "object" || p.properties) return true;
	if (p.type === "array") return needsJsonRoundTrip(p.items);
	return false;
}

export function fixToolSchema(schema: unknown): { schema: JsonSchema; jsonFields: string[] } {
	const result: JsonSchema = { type: "object", required: [], properties: {} };
	const jsonFields: string[] = [];

	if (!schema || typeof schema !== "object") {
		return { schema: { ...result, properties: {} }, jsonFields };
	}

	const s = schema as JsonSchema;
	const properties = (s.properties as Record<string, unknown>) || {};

	for (const [name, prop] of Object.entries(properties)) {
		if (needsJsonRoundTrip(prop)) {
			jsonFields.push(name);
			const p = prop as JsonSchema;
			const shape = JSON.stringify(prop, (k, v) => (EMBED_STRIP_KEYS.has(k) ? undefined : v));
			const desc = typeof p.description === "string" ? `${p.description} ` : "";
			(result.properties as Record<string, unknown>)[name] = {
				type: "string",
				description: `${desc}JSON string matching: ${shape}`,
			};
		} else {
			(result.properties as Record<string, unknown>)[name] = simplifyProperty(prop);
		}
	}

	if (Array.isArray(s.required)) {
		result.required = (s.required as string[]).filter((n) => n in (result.properties as object));
	}

	return { schema: result, jsonFields };
}

export type CoercionMap = Record<string, string[]>;

export function fixOpenAIChatPayload(payload: unknown): { payload: unknown; coercion: CoercionMap } {
	if (!payload || typeof payload !== "object") {
		return { payload, coercion: {} };
	}
	const body = { ...(payload as Record<string, unknown>) };
	const coercion: CoercionMap = {};

	if (!Array.isArray(body.tools)) {
		return { payload: body, coercion };
	}

	body.tools = (body.tools as unknown[]).map((tool) => {
		if (!tool || typeof tool !== "object") return tool;
		const t = tool as Record<string, unknown>;
		const fn = t.function as Record<string, unknown> | undefined;
		if (!fn) return tool;
		const { schema, jsonFields } = fixToolSchema(fn.parameters);
		const name = typeof fn.name === "string" ? fn.name : undefined;
		if (jsonFields.length && name) {
			coercion[name] = jsonFields;
		}
		return {
			...t,
			function: { ...fn, parameters: schema },
		};
	});

	return { payload: body, coercion };
}