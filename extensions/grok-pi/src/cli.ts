// Pure helpers for driving the official `grok` CLI in single-turn (headless)
// mode. No runtime imports here — this module is imported directly by tests
// via Node's TypeScript stripping, so only `import type` is allowed.
import type {
	Context,
	ImageContent,
	Message,
	TextContent,
	Tool,
} from "@earendil-works/pi-ai";

const EFFORT_BY_LEVEL: Record<string, string> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "xhigh",
};

/** Map a Pi thinking level to the `--effort` value for the grok CLI. */
export function effortArg(level: string | undefined): string | undefined {
	if (!level || level === "off") return undefined;
	return EFFORT_BY_LEVEL[level] ?? "high";
}

/**
 * Build argv for one headless grok model turn.
 *
 * Every request spawns the real, unmodified `grok` binary in its own supported
 * single-turn mode (`--single`). Grok's own tools are disabled with
 * `--tools ""` (+ `--disable-web-search` for belt and braces) so Pi executes
 * all real file/shell/network/MCP actions; auth stays entirely inside the CLI.
 */
export function buildGrokArgs(modelId: string, thinkingLevel?: string, prompt?: string): string[] {
	const args = [
		"--output-format", "json",
		"--permission-mode", "dontAsk",
		"--tools", "",
		"--disable-web-search",
		"--model", modelId,
	];
	const effort = effortArg(thinkingLevel);
	if (effort) args.push("--effort", effort);
	if (prompt !== undefined) args.push("--single", prompt);
	return args;
}

/** Canonical smoke-test command shown by /grok-pi status|test. */
export function smokeTestCommand(bin: string, modelId: string): string {
	return `${bin} --single "Reply with exactly OK" --model ${modelId} --tools "" --disable-web-search --permission-mode dontAsk --output-format json`;
}

// ── Prompt serialization ────────────────────────────────────────────────────

// The grok CLI subprocess accepts plain-text prompts only, so image content
// must be dropped. Warn exactly once per session so degraded turns are loud,
// not silent.
let imageDropWarned = false;

/** Reset the one-time image-drop warning (used by tests). */
export function resetImageDropWarning(): void {
	imageDropWarned = false;
}

export const IMAGE_DROP_WARNING =
	"grok-pi: image input is not supported by the grok CLI subprocess bridge; " +
	"images were replaced with '[image omitted: …]' placeholders in the prompt.";

function contentToText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content
		.map((item) => {
			if (item.type === "text") return item.text;
			if (!imageDropWarned) {
				imageDropWarned = true;
				console.warn(IMAGE_DROP_WARNING);
			}
			return `[image omitted: ${item.mimeType}]`;
		})
		.join("\n");
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function serializeMessage(message: Message): string {
	if (message.role === "user") {
		return `USER:\n${contentToText(message.content)}`;
	}

	if (message.role === "toolResult") {
		return [
			`PI TOOL RESULT (${message.toolName}, id=${message.toolCallId}, isError=${message.isError}):`,
			contentToText(message.content),
		].join("\n");
	}

	const parts = message.content.map((part: any) => {
		if (part.type === "text") return part.text;
		if (part.type === "thinking") return `<thinking>${part.thinking}</thinking>`;
		return `<pi_tool_call>${safeJson({ name: part.name, arguments: part.arguments })}</pi_tool_call>`;
	});
	return `ASSISTANT:\n${parts.join("\n")}`;
}

function serializeTools(tools?: Tool[]): string {
	if (!tools || tools.length === 0) return "No Pi tools are available for this turn.";
	return safeJson(
		tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		})),
	);
}

export function buildPrompt(context: Pick<Context, "systemPrompt" | "messages" | "tools">): string {
	const sections: string[] = [];
	sections.push(`# Pi/Grok CLI bridge instructions

You are being used as the model backend for Pi Coding Agent through the local Grok CLI in single-turn mode.
The extension invokes the grok binary with \`--single\` for each model turn.
Grok's own tools are disabled with \`--tools ""\`; Pi, not Grok, executes real file, shell, network, and MCP actions.

If you need Pi to run a tool, output only one or more tool-call blocks and no prose:
<pi_tool_call>{"name":"tool_name","arguments":{}}</pi_tool_call>

Rules for Pi tool calls:
- Use only tools listed in the "Available Pi tools" section.
- The JSON inside <pi_tool_call> must be valid JSON with "name" and "arguments" fields.
- Do not wrap tool calls in Markdown fences.
- If you can answer without a tool, answer normally in plain text.
- After Pi returns tool results, continue from the transcript and either answer or request another Pi tool call.`);

	if (context.systemPrompt?.trim()) {
		sections.push(`# Pi system prompt\n\n${context.systemPrompt}`);
	}

	sections.push(`# Available Pi tools\n\n${serializeTools(context.tools)}`);

	if (context.messages.length > 0) {
		sections.push(
			`# Conversation transcript\n\n${context.messages.map(serializeMessage).join("\n\n---\n\n")}`,
		);
	} else {
		sections.push("# Conversation transcript\n\n(no prior messages)");
	}

	sections.push("Now produce the next assistant message for Pi.");
	return sections.join("\n\n---\n\n");
}

// ── Tool-call parsing ───────────────────────────────────────────────────────

export function parseToolCalls(text: string): Array<{ name: string; arguments: Record<string, any> }> {
	const tagRegex = /<pi_tool_call>([\s\S]*?)<\/pi_tool_call>/g;
	const matches = [...text.trim().matchAll(tagRegex)];
	return matches.flatMap((match) => parseToolCallJson(match[1] ?? ""));
}

function parseToolCallJson(raw: string): Array<{ name: string; arguments: Record<string, any> }> {
	let value: any;
	try {
		value = JSON.parse(raw.trim());
	} catch {
		return [];
	}

	const candidates = Array.isArray(value)
		? value
		: Array.isArray(value?.tool_calls)
			? value.tool_calls
			: [value];
	const calls: Array<{ name: string; arguments: Record<string, any> }> = [];
	for (const candidate of candidates) {
		const name =
			typeof candidate?.name === "string"
				? candidate.name
				: typeof candidate?.tool === "string"
					? candidate.tool
					: undefined;
		const args = candidate?.arguments ?? candidate?.args ?? candidate?.input ?? {};
		if (!name || typeof args !== "object" || args === null || Array.isArray(args)) continue;
		calls.push({ name, arguments: args });
	}
	return calls;
}

/** Strip any stray tool-call markers from display text. */
export function stripToolMarkers(text: string): string {
	return text.replace(/<pi_tool_call>[\s\S]*?<\/pi_tool_call>/g, "").trim();
}

/**
 * Split a model response into the prose around `<pi_tool_call>` blocks and the
 * parsed tool calls themselves, so surrounding text is never silently dropped.
 */
export function splitResponse(text: string): {
	prose: string;
	calls: Array<{ name: string; arguments: Record<string, any> }>;
} {
	return { prose: stripToolMarkers(text), calls: parseToolCalls(text) };
}

/** Tail cap for subprocess output accumulation (stdout and stderr alike). */
export const OUTPUT_LIMIT = 20_000;

/** Append a chunk to an accumulator, keeping only the last `limit` chars. */
export function appendCapped(current: string, chunk: string, limit = OUTPUT_LIMIT): string {
	return (current + chunk).slice(-limit);
}

/**
 * Generous guard for JSON stdout accumulation. Unlike appendCapped's tail
 * truncation (which would corrupt a leading `{`), JSON payloads must stay
 * complete to parse; runaway output is rejected instead of spliced.
 */
export const STDOUT_LIMIT = 8_000_000;

/** Append a stdout chunk without truncation; throws past STDOUT_LIMIT. */
export function appendStdout(current: string, chunk: string): string {
	const next = current + chunk;
	if (next.length > STDOUT_LIMIT) {
		throw new Error(`grok --single produced more than ${STDOUT_LIMIT} chars of output`);
	}
	return next;
}

// ── `--output-format json` parsing ─────────────────────────────────────────

export type GrokCliResult = {
	text?: string;
	stopReason?: string;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		reasoning_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
		total_tokens?: number;
	};
	total_cost_usd?: number;
};

/**
 * True when a parsed object plausibly looks like a `grok --single --output-format json`
 * payload (rather than some unrelated JSON that happened to appear on stdout).
 */
function looksLikeGrokPayload(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return "text" in record || "output" in record || "usage" in record || "stopReason" in record;
}

/**
 * Collect JSON-object candidates from mixed stdout: the span between the first
 * '{' and the last '}', plus any line that is itself a complete JSON object.
 */
function extractJsonCandidates(stdout: string): string[] {
	const candidates: string[] = [];
	const start = stdout.indexOf("{");
	const end = stdout.lastIndexOf("}");
	if (start !== -1 && end > start) {
		candidates.push(stdout.slice(start, end + 1));
	}
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("{") && trimmed.endsWith("}") && !candidates.includes(trimmed)) {
			candidates.push(trimmed);
		}
	}
	return candidates;
}

/** Parse embedded candidates, preferring objects shaped like a grok payload. */
function parseEmbeddedJson(stdout: string): GrokCliResult | null {
	const parsedValues: GrokCliResult[] = [];
	for (const candidate of extractJsonCandidates(stdout)) {
		try {
			parsedValues.push(JSON.parse(candidate) as GrokCliResult);
		} catch {
			// not valid JSON; skip
		}
	}
	return (
		parsedValues.find((value) => looksLikeGrokPayload(value)) ?? parsedValues.find((value) => value && typeof value === "object") ?? null
	);
}

/**
 * Parse one `grok --single --output-format json` invocation. Tolerates stray
 * non-JSON lines around the payload (update banners, warnings) by locating the
 * embedded JSON object. Falls back to treating stdout as plain text only when
 * nothing parses.
 */
export function parseGrokCliOutput(stdout: string): GrokCliResult {
	try {
		const parsed = JSON.parse(stdout) as GrokCliResult;
		if (parsed && typeof parsed === "object") return parsed;
	} catch {
		// fall through to embedded-JSON recovery
	}
	return parseEmbeddedJson(stdout) ?? { text: stdout };
}
