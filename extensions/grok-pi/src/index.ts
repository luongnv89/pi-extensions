import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	type GrokModelInfo,
	type GrokModelsCache,
	buildProviderModels,
	modelsFromCache,
	supportedThinkingLevels,
} from "./models.js";
import { grokHarnessStateIn, grokReadinessLabel, grokInstallGuidance, grokAuthGuidance } from "./harness.js";
import { formatUsageCard } from "./usage.js";

const PROVIDER_ID = "grok-cli";
const PROXY_BASE = "https://cli-chat-proxy.grok.com/v1";
const GROK_HOME = join(homedir(), ".grok");
const AUTH_PATH = join(GROK_HOME, "auth.json");
const MODELS_CACHE_PATH = join(GROK_HOME, "models_cache.json");
const VERSION_PATH = join(GROK_HOME, "version.json");

const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(extensionDir);
const binDir = join(packageRoot, "bin");
const apiKeyHelper = join(binDir, "grok-api-key");
const clientVersionHelper = join(binDir, "grok-client-version");
const userAgentHelper = join(binDir, "grok-user-agent");
const usageHelper = join(binDir, "grok-usage");
const execFileAsync = promisify(execFile);

function readJson<T>(path: string): T | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return null;
	}
}

function readCachedModels(): GrokModelInfo[] {
	return modelsFromCache(readJson<GrokModelsCache>(MODELS_CACHE_PATH));
}

function registerGrokProvider(pi: ExtensionAPI) {
	const models = buildProviderModels(readCachedModels());

	pi.registerProvider(PROVIDER_ID, {
		name: "Grok CLI",
		baseUrl: PROXY_BASE,
		api: "openai-responses",
		apiKey: `!${apiKeyHelper}`,
		headers: {
			"X-XAI-Token-Auth": "xai-grok-cli",
			"x-grok-client-version": `!${clientVersionHelper}`,
			"User-Agent": `!${userAgentHelper}`,
		},
		models,
	});
}

function statusLines(): string[] {
	const lines: string[] = [];
	const harness = grokHarnessStateIn(GROK_HOME);
	lines.push(`Provider: ${PROVIDER_ID}`);
	lines.push(`Proxy: ${PROXY_BASE}`);
	lines.push(`Grok home: ${GROK_HOME}`);
	lines.push(`Grok CLI installed: ${harness.installed ? "yes" : "no"}`);
	lines.push(`Auth file present: ${harness.authPresent ? "yes" : "no"}`);
	lines.push(`Ready: ${grokReadinessLabel(harness)}`);
	if (harness.authPresent) {
		lines.push(`Auth path: ${AUTH_PATH}`);
	}
	lines.push(`Models cache: ${existsSync(MODELS_CACHE_PATH) ? MODELS_CACHE_PATH : "missing (using bundled defaults)"}`);
	lines.push("");
	lines.push("Registered models:");
	for (const info of readCachedModels()) {
		const levels = supportedThinkingLevels(info);
		const thinking =
			levels.length > 0 ? ` thinking: ${levels.join(", ")}` : " thinking: off";
		lines.push(`  - ${info.model}${info.name ? ` (${info.name})` : ""}${thinking}`);
	}
	lines.push("");
	lines.push("Thinking: Shift+Tab cycles Pi thinking levels; /settings or --thinking <level>.");
	lines.push("");
	lines.push("Quick test:");
	const smokeModel = readCachedModels()[0]?.model ?? "grok-4.6";
	lines.push(
		`  pi -p --provider ${PROVIDER_ID} --model ${smokeModel} "Reply with exactly OK"`,
	);
	return lines;
}

async function fetchGrokUsage(ctx: ExtensionCommandContext): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync(usageHelper, [], {
			timeout: 15_000,
			maxBuffer: 200_000,
		});
		return formatUsageCard(stdout.trim());
	} catch (error) {
		const maybeOutput = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
		const stdout = maybeOutput.stdout?.toString().trim();
		if (stdout) return formatUsageCard(stdout);

		const detail = maybeOutput.stderr?.toString().trim() || maybeOutput.message || String(error);
		ctx.ui.notify(`grok-pi usage failed: ${detail}`, "warning");
		return null;
	}
}

export default function grokPiExtension(pi: ExtensionAPI) {
	registerGrokProvider(pi);

	pi.on("session_start", async (_event, ctx) => {
		const harness = grokHarnessStateIn(GROK_HOME);
		if (!harness.installed) {
			ctx.ui.notify(grokInstallGuidance(), "warning");
			return;
		}
		if (!harness.authPresent) {
			ctx.ui.notify(grokAuthGuidance(), "warning");
			return;
		}
		ctx.ui.notify(
			`grok-pi: registered ${PROVIDER_ID} (${readCachedModels().length} model(s)). Use /model or --provider ${PROVIDER_ID}.`,
			"info",
		);
	});

	pi.registerCommand("grok-pi", {
		description: "Grok CLI bridge status and setup help",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "status";

			if (sub === "status") {
				for (const line of statusLines()) {
					ctx.ui.notify(line, "info");
				}
				return;
			}

			if (sub === "models") {
				for (const info of readCachedModels()) {
					const levels = supportedThinkingLevels(info);
					const thinking = levels.length > 0 ? levels.join(", ") : "off";
					ctx.ui.notify(
						`${PROVIDER_ID}/${info.model} — ${info.name ?? info.model} [${thinking}]`,
						"info",
					);
				}
				ctx.ui.notify(`Also run: pi --list-models grok`, "info");
				return;
			}

			if (sub === "test") {
				const smokeModel = readCachedModels()[0]?.model ?? "grok-4.6";
				ctx.ui.notify(
					`Run: pi -p --provider ${PROVIDER_ID} --model ${smokeModel} --thinking medium "Reply with exactly OK"`,
					"info",
				);
				return;
			}

			if (sub === "usage") {
				const result = await fetchGrokUsage(ctx);
				if (result) {
					ctx.ui.notify(result, "info");
				}
				return;
			}

			if (sub === "help") {
				ctx.ui.notify("Usage: /grok-pi [status|models|test|usage|help]", "info");
				ctx.ui.notify("Install the Grok CLI first: https://x.ai/grok", "info");
				ctx.ui.notify("Authenticate first with: grok login", "info");
				ctx.ui.notify("Thinking: Shift+Tab, /settings, or --thinking <low|medium|high|xhigh>", "info");
				return;
			}

			ctx.ui.notify(`Unknown /grok-pi subcommand: ${sub}. Try /grok-pi help`, "warning");
		},
	});
}