import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChildProcess } from "node:child_process";
import {
	calculateCost,
	createAssistantMessageEventStream,
	registerApiProvider,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type ToolCall,
} from "@earendil-works/pi-ai";
import { appendCapped, appendStdout, buildGrokArgs, buildPrompt, parseGrokCliOutput, smokeTestCommand, splitResponse } from "./cli.js";
import { buildProviderModels, modelsFromCache, supportedThinkingLevels, type GrokModelInfo, type GrokModelsCache } from "./models.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROVIDER_ID = "grok-cli";
const API_ID = "grok-cli-runner";
const REQUEST_TIMEOUT_MS = 5 * 60_000;
const KILL_GRACE_MS = 5_000;

/** Root of the Grok CLI harness; override with GROK_PI_HOME. */
export function grokHome(): string {
	return process.env.GROK_PI_HOME?.trim() || join(homedir(), ".grok");
}

/** Read-only model metadata cache inside the Grok CLI harness directory. */
export function modelsCachePath(): string {
	return join(grokHome(), "models_cache.json");
}

export function grokBin(): string {
	return process.env.GROK_PI_BIN?.trim() || "grok";
}

function requestTimeoutMs(): number {
	const configured = Number(process.env.GROK_PI_TIMEOUT_MS);
	if (Number.isFinite(configured) && configured > 0) return configured;
	return REQUEST_TIMEOUT_MS;
}

function readJson<T>(path: string): T | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return null;
	}
}

/** Read-only model metadata from the CLI's own cache (or env override). */
export function readCachedModels(): GrokModelInfo[] {
	const envModels = process.env.GROK_PI_MODELS?.trim();
	if (envModels) {
		return envModels
			.split(/[\s,]+/)
			.map((id) => id.trim())
			.filter(Boolean)
			.map((model) => ({ model }));
	}
	return modelsFromCache(readJson<GrokModelsCache>(modelsCachePath()));
}

// ── Subprocess lifecycle ────────────────────────────────────────────────────

/** SIGTERM the whole process group, then SIGKILL it after a short grace period. */
function killTree(child: ChildProcess): void {
	if (child.pid === undefined) return;
	const pid = child.pid;
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		child.kill("SIGTERM");
	}
	const grace = setTimeout(() => {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	}, KILL_GRACE_MS);
	grace.unref?.();
	child.once("close", () => clearTimeout(grace));
	child.once("exit", () => clearTimeout(grace));
}

// ── Status probing ──────────────────────────────────────────────────────────

export type CliStatus = {
	ok: boolean;
	summary: string;
	detail?: string;
};

function runCapture(
	args: string[],
	input?: string,
	timeoutMs = 10_000,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
	return new Promise((resolve, reject) => {
		const child = spawn(grokBin(), args, {
			stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			env: { ...process.env },
			detached: true,
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		let exitCode: number | null = null;
		const timer = setTimeout(() => {
			timedOut = true;
			killTree(child);
		}, timeoutMs);

		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (timedOut) {
				reject(new Error(`grok timed out after ${timeoutMs}ms`));
			} else {
				resolve({ stdout, stderr, code: exitCode });
			}
		};

		child.stdout!.setEncoding("utf8");
		child.stderr!.setEncoding("utf8");
		child.stdout!.on("data", (chunk) => {
			stdout = appendCapped(stdout, chunk);
		});
		child.stderr!.on("data", (chunk) => {
			stderr = appendCapped(stderr, chunk);
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			if (!settled) {
				settled = true;
				reject(error);
			}
		});
		child.on("close", (code) => {
			exitCode = code;
			finish();
		});

		if (input !== undefined) child.stdin!.end(input);
	});
}

export async function checkCliStatus(): Promise<CliStatus> {
	try {
		const result = await runCapture(["--version"]);
		if (result.code !== 0) {
			const detail =
				result.stderr.trim() || result.stdout.trim() || `grok --version exited with code ${result.code}`;
			return { ok: false, summary: "Grok CLI is unusable", detail };
		}
		const version = result.stdout.trim() || result.stderr.trim() || "grok is available";
		return { ok: true, summary: version };
	} catch (error) {
		return {
			ok: false,
			summary: "Grok CLI is unavailable",
			detail: error instanceof Error ? error.message : String(error),
		};
	}
}

export function setupGuidance(error: string): string {
	return [
		"grok-pi could not use the local Grok CLI.",
		`Reason: ${error}`,
		"Install Grok CLI (https://x.ai/grok), ensure `grok --version` works on PATH, run `grok login`, then reload Pi.",
		"This provider never falls back to direct HTTP APIs or xAI proxy endpoints; every request must go through the local `grok` binary.",
	].join(" ");
}

// ── Streaming bridge ────────────────────────────────────────────────────────

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

function setEstimatedUsage(model: Model<Api>, output: AssistantMessage, prompt: string, text: string) {
	if (output.usage.totalTokens > 0) return;
	output.usage.input = estimateTokens(prompt);
	output.usage.output = estimateTokens(text);
	output.usage.totalTokens = output.usage.input + output.usage.output;
	calculateCost(model, output.usage);
}

/**
 * Stream one grok model turn by spawning the official `grok --single`
 * headless mode. Auth, token refresh, headers, and telemetry stay entirely
 * inside the real binary — this extension never reads credentials or talks
 * HTTP to xAI itself.
 */
export function streamGrokCli(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const prompt = buildPrompt(context);
		const timeout = requestTimeoutMs();
		let stderr = "";
		let stdout = "";
		let settled = false;
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abort: (() => void) | undefined;
		const detachAbort = () => {
			if (abort) options?.signal?.removeEventListener("abort", abort);
		};
		let stdoutError: Error | undefined;

		try {
			stream.push({ type: "start", partial: output });
			const args = buildGrokArgs(model.id, options?.reasoning as string | undefined, prompt);

			const child = spawn(grokBin(), args, {
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env },
				detached: true,
			});

			abort = () => killTree(child);
			timer = setTimeout(() => {
				timedOut = true;
				killTree(child);
			}, timeout);
			options?.signal?.addEventListener("abort", abort, { once: true });

			child.stdin!.end();
			child.stdout!.setEncoding("utf8");
			child.stderr!.setEncoding("utf8");
			child.stdout!.on("data", (chunk: string) => {
				if (stdoutError) return;
				try {
					stdout = appendStdout(stdout, chunk);
				} catch (error) {
					stdoutError = error instanceof Error ? error : new Error(String(error));
					killTree(child);
				}
			});
			child.stderr!.on("data", (chunk: string) => {
				stderr = appendCapped(stderr, chunk);
			});

			const code = await new Promise<number | null>((resolve, reject) => {
				child.on("error", reject);
				child.on("close", resolve);
			});
			settled = true;
			if (timer) clearTimeout(timer);
			detachAbort();

			if (stdoutError) throw stdoutError;
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			if (timedOut) throw new Error(`grok --single timed out after ${timeout}ms`);
			if (code !== 0) throw new Error(stderr.trim() || `grok --single exited with code ${code}`);

			const parsed = parseGrokCliOutput(stdout);
			const responseText = parsed.text ?? "";

			// Real usage from the CLI's JSON output when available.
			if (parsed.usage) {
				output.usage.input = Number(parsed.usage.input_tokens ?? 0);
				output.usage.output = Number(
					(parsed.usage.output_tokens ?? 0) + (parsed.usage.reasoning_tokens ?? 0),
				);
				output.usage.cacheRead = Number(parsed.usage.cache_read_input_tokens ?? 0);
				output.usage.cacheWrite = Number(parsed.usage.cache_creation_input_tokens ?? 0);
				output.usage.totalTokens = Number(parsed.usage.total_tokens ?? 0) ||
					output.usage.input + output.usage.output;
				if (typeof parsed.total_cost_usd === "number") {
					output.usage.cost.total = parsed.total_cost_usd;
				}
			} else {
				setEstimatedUsage(model, output, prompt, responseText);
			}

			const { prose, calls } = splitResponse(responseText);
			if (calls.length > 0) {
				output.stopReason = "toolUse";
				if (prose) {
					const proseIndex = output.content.length;
					output.content.push({ type: "text", text: prose });
					stream.push({ type: "text_start", contentIndex: proseIndex, partial: output });
					stream.push({ type: "text_delta", contentIndex: proseIndex, delta: prose, partial: output });
					stream.push({ type: "text_end", contentIndex: proseIndex, content: prose, partial: output });
				}
				for (const call of calls) {
					const toolCall: ToolCall = {
						type: "toolCall",
						id: `grok_pi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
						name: call.name,
						arguments: call.arguments,
					};
					const toolIndex = output.content.length;
					output.content.push(toolCall);
					stream.push({ type: "toolcall_start", contentIndex: toolIndex, partial: output });
					stream.push({
						type: "toolcall_delta",
						contentIndex: toolIndex,
						delta: safeJsonArgs(toolCall.arguments),
						partial: output,
					});
					stream.push({ type: "toolcall_end", contentIndex: toolIndex, toolCall, partial: output });
				}
				stream.push({ type: "done", reason: "toolUse", message: output });
				stream.end();
				return;
			}

			const contentIndex = output.content.length;
			output.content.push({ type: "text", text: responseText });
			stream.push({ type: "text_start", contentIndex, partial: output });
			if (responseText) {
				stream.push({ type: "text_delta", contentIndex, delta: responseText, partial: output });
			}
			stream.push({ type: "text_end", contentIndex, content: responseText, partial: output });
			stream.push({ type: "done", reason: "stop", message: output });
			stream.end();
		} catch (error) {
			detachAbort();
			if (timer && !settled) clearTimeout(timer);
			const aborted = options?.signal?.aborted === true;
			output.stopReason = aborted ? "aborted" : "error";
			const rawMessage = error instanceof Error ? error.message : String(error);
			// Abort and timeout are routine — don't tell users to reinstall or re-login.
			output.errorMessage = aborted
				? "Request was aborted"
				: timedOut
					? `grok --single timed out after ${timeout}ms`
					: setupGuidance(rawMessage);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

function safeJsonArgs(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return "{}";
	}
}

// ── Provider registration ───────────────────────────────────────────────────

export function registerGrokProviderBridge(pi: ExtensionAPI) {
	const models = buildProviderModels(readCachedModels());

	pi.registerProvider(PROVIDER_ID, {
		name: "Grok CLI",
		baseUrl: "cli:grok-single",
		apiKey: "grok-cli-no-api-key",
		api: API_ID,
		models,
		streamSimple: streamGrokCli,
	});

	registerApiProvider(
		{
			api: API_ID,
			stream: streamGrokCli,
			streamSimple: streamGrokCli,
		},
		PROVIDER_ID,
	);
}

// ── Status lines for /grok-pi status ────────────────────────────────────────

export function cliStatusLines(status: CliStatus, cachedModels?: GrokModelInfo[]): string[] {
	const models = cachedModels ?? readCachedModels();
	const lines = [
		`Provider: ${PROVIDER_ID}`,
		`Grok binary: ${grokBin()}`,
		"Transport: strictly local `grok --single` per model turn",
		"Fallbacks: none (no direct HTTP, no header spoofing, no credential access)",
		'Own Grok tools: disabled via --tools "" + --disable-web-search',
		"Thinking: --effort mapped from Pi thinking levels (minimal→low … xhigh)",
		`Registered models: ${models.length}`,
		`Models metadata: ${(() => {
			const cachePath = modelsCachePath();
			return existsSync(cachePath) ? cachePath : "bundled defaults (read-only)";
		})()}`,
	];

	lines.push("");
	for (const info of models) {
		const levels = supportedThinkingLevels(info);
		const thinking = levels.length > 0 ? ` thinking: ${levels.join(", ")}` : " thinking: off";
		lines.push(`  - ${info.model}${info.name ? ` (${info.name})` : ""}${thinking}`);
	}

	lines.push("");
	lines.push("Quick test:");
	lines.push(`  pi -p --provider ${PROVIDER_ID} --model ${models[0]?.model ?? "grok-4.6"} "Reply with exactly OK"`);
	lines.push("Direct CLI smoke test:");
	lines.push(`  ${smokeTestCommand(grokBin(), models[0]?.model ?? "grok-4.6")}`);
	return lines;
}
