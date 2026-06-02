import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

type GrokModelInfo = {
	model: string;
	name?: string;
	context_window?: number;
	max_completion_tokens?: number | null;
	api_backend?: string;
};

type GrokModelsCache = {
	models?: Record<
		string,
		{
			info?: GrokModelInfo;
		}
	>;
};

function readJson<T>(path: string): T | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return null;
	}
}

function grokInstalled(): boolean {
	return existsSync(AUTH_PATH) || existsSync(join(GROK_HOME, "bin", "grok"));
}

function authPresent(): boolean {
	return existsSync(AUTH_PATH);
}

function readCachedModels(): GrokModelInfo[] {
	const cache = readJson<GrokModelsCache>(MODELS_CACHE_PATH);
	if (!cache?.models) {
		return defaultModelCatalog();
	}
	const out: GrokModelInfo[] = [];
	for (const entry of Object.values(cache.models)) {
		const info = entry?.info;
		if (!info?.model) continue;
		out.push(info);
	}
	return out.length > 0 ? out : defaultModelCatalog();
}

function defaultModelCatalog(): GrokModelInfo[] {
	return [
		{
			model: "grok-composer-2.5-fast",
			name: "Composer 2.5",
			context_window: 200_000,
			max_completion_tokens: 30_000,
			api_backend: "responses",
		},
		{
			model: "grok-build",
			name: "Grok Build",
			context_window: 512_000,
			max_completion_tokens: 64_000,
			api_backend: "responses",
		},
	];
}

function maxTokensFor(info: GrokModelInfo): number {
	if (typeof info.max_completion_tokens === "number" && info.max_completion_tokens > 0) {
		return info.max_completion_tokens;
	}
	if (info.model.includes("composer")) return 30_000;
	if (info.model.includes("build")) return 64_000;
	return 16_384;
}

function inputFor(info: GrokModelInfo): ("text" | "image")[] {
	if (info.model.includes("build")) return ["text", "image"];
	return ["text"];
}

function registerGrokProvider(pi: ExtensionAPI) {
	const models = readCachedModels().map((info) => ({
		id: info.model,
		name: info.name ? `${info.name} (Grok CLI)` : `${info.model} (Grok CLI)`,
		reasoning: false,
		input: inputFor(info),
		contextWindow: info.context_window ?? 128_000,
		maxTokens: maxTokensFor(info),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		headers: {
			"x-grok-model-override": info.model,
		},
		compat: {
			sendSessionIdHeader: false,
			supportsLongCacheRetention: false,
		},
	}));

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
	lines.push(`Provider: ${PROVIDER_ID}`);
	lines.push(`Proxy: ${PROXY_BASE}`);
	lines.push(`Grok home: ${GROK_HOME}`);
	lines.push(`Grok CLI installed: ${grokInstalled() ? "yes" : "no"}`);
	lines.push(`Auth file present: ${authPresent() ? "yes" : "no"}`);
	if (authPresent()) {
		lines.push(`Auth path: ${AUTH_PATH}`);
	}
	lines.push(`Models cache: ${existsSync(MODELS_CACHE_PATH) ? MODELS_CACHE_PATH : "missing (using bundled defaults)"}`);
	lines.push("");
	lines.push("Registered models:");
	for (const info of readCachedModels()) {
		lines.push(`  - ${info.model}${info.name ? ` (${info.name})` : ""}`);
	}
	lines.push("");
	lines.push("Quick test:");
	lines.push(
		`  pi -p --provider ${PROVIDER_ID} --model grok-composer-2.5-fast "Reply with exactly OK"`,
	);
	return lines;
}

export default function grokPiExtension(pi: ExtensionAPI) {
	registerGrokProvider(pi);

	pi.on("session_start", async (_event, ctx) => {
		if (!authPresent()) {
			ctx.ui.notify(
				"grok-pi: no ~/.grok/auth.json yet. Run `grok login`, then `/reload` or restart Pi.",
				"warning",
			);
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
					ctx.ui.notify(
						`${PROVIDER_ID}/${info.model} — ${info.name ?? info.model}`,
						"info",
					);
				}
				ctx.ui.notify(`Also run: pi --list-models grok`, "info");
				return;
			}

			if (sub === "test") {
				ctx.ui.notify(
					`Run: pi -p --provider ${PROVIDER_ID} --model grok-composer-2.5-fast "Reply with exactly OK"`,
					"info",
				);
				return;
			}

			if (sub === "help") {
				ctx.ui.notify("Usage: /grok-pi [status|models|test|help]", "info");
				ctx.ui.notify("Authenticate first with: grok login", "info");
				return;
			}

			ctx.ui.notify(`Unknown /grok-pi subcommand: ${sub}. Try /grok-pi help`, "warning");
		},
	});
}