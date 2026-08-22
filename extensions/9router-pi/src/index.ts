import { getAgentDir, type ExtensionAPI, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROVIDER_ID = "9router";
const DEFAULT_BASE_URL = "http://localhost:20128/v1";
const DISCOVERY_TIMEOUT_MS = 5000;
const ZERO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};

const SUPPORTED_THINKING_FORMATS = [
	"openai",
	"openrouter",
	"deepseek",
	"together",
	"zai",
	"qwen",
	"qwen-chat-template",
] as const;

type SupportedThinkingFormat = (typeof SUPPORTED_THINKING_FORMATS)[number];
type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

type RouterModelInfo = {
	id?: unknown;
	context_length?: unknown;
	max_completion_tokens?: unknown;
	capabilities?: {
		vision?: unknown;
		reasoning?: unknown;
		thinkingFormat?: unknown;
		thinkingCanDisable?: unknown;
	};
};

export type RouterModelsResponse = {
	data?: RouterModelInfo[];
};

export type RouterPiModel = {
	id: string;
	name: string;
	baseUrl?: string;
	reasoning: boolean;
	thinkingLevelMap?: Partial<Record<PiThinkingLevel, string | null>>;
	input: ("text" | "image")[];
	cost: typeof ZERO_COST;
	contextWindow: number;
	maxTokens: number;
	compat?: { thinkingFormat: SupportedThinkingFormat };
};

function positiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function normalizeBaseUrl(value: string | undefined): string {
	const configured = value?.trim();
	return (configured || DEFAULT_BASE_URL).replace(/\/+$/u, "");
}

function thinkingFormatFor(value: unknown): SupportedThinkingFormat | undefined {
	if (typeof value !== "string") return undefined;
	return (SUPPORTED_THINKING_FORMATS as readonly string[]).includes(value)
		? (value as SupportedThinkingFormat)
		: undefined;
}

function hasModelId(model: RouterModelInfo): model is RouterModelInfo & { id: string } {
	return typeof model.id === "string" && model.id.trim().length > 0;
}

export function normalizeModels(payload: RouterModelsResponse): RouterPiModel[] {
	const seen = new Set<string>();
	const models: RouterPiModel[] = [];

	for (const model of payload.data ?? []) {
		if (!hasModelId(model)) continue;
		const id = model.id.trim();
		if (seen.has(id)) continue;
		seen.add(id);

		const capabilities = model.capabilities;
		const reasoning = capabilities?.reasoning === true;
		const thinkingFormat = thinkingFormatFor(capabilities?.thinkingFormat);
		const thinkingLevelMap =
			reasoning && capabilities?.thinkingCanDisable === false
				? { off: null }
				: undefined;

		models.push({
			id,
			name: id,
			reasoning,
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			input: capabilities?.vision === true ? ["text", "image"] : ["text"],
			cost: ZERO_COST,
			contextWindow: positiveNumber(model.context_length, 128000),
			maxTokens: positiveNumber(model.max_completion_tokens, 16384),
			...(thinkingFormat ? { compat: { thinkingFormat } } : {}),
		});
	}

	return models;
}

async function fetchPayload(baseUrl: string, signal?: AbortSignal): Promise<RouterModelsResponse> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
	const abortFromParent = () => controller.abort(signal?.reason);

	if (signal?.aborted) {
		abortFromParent();
	} else {
		signal?.addEventListener("abort", abortFromParent, { once: true });
	}

	try {
		const response = await fetch(`${baseUrl}/models`, { signal: controller.signal });
		if (!response.ok) {
			throw new Error(`9router model discovery failed: HTTP ${response.status}`);
		}
		return (await response.json()) as RouterModelsResponse;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abortFromParent);
	}
}

export async function discoverModels(
	baseUrl = configuredBaseUrl(),
	signal?: AbortSignal,
): Promise<RouterPiModel[]> {
	const models = normalizeModels(await fetchPayload(normalizeBaseUrl(baseUrl), signal));
	if (models.length === 0) {
		throw new Error("9router model discovery returned no models");
	}
	return models;
}

function apiKeyFromEnvironment(): string | undefined {
	const value = process.env.NINE_ROUTER_API_KEY?.trim();
	return value || undefined;
}

function stripJsonComments(input: string): string {
	const withoutComments = input.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/gu, (match) =>
		match.startsWith('"') ? match : "",
	);
	let output = "";
	let inString = false;
	let escaped = false;

	for (let index = 0; index < withoutComments.length; index += 1) {
		const character = withoutComments[index];
		if (inString) {
			output += character;
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}

		if (character === '"') {
			inString = true;
			output += character;
			continue;
		}
		if (character === ",") {
			let next = index + 1;
			while (/\s/u.test(withoutComments[next] ?? "")) next += 1;
			if (withoutComments[next] === "}" || withoutComments[next] === "]") continue;
		}
		output += character;
	}

	return output;
}

type ModelsJsonModel = Partial<ProviderModelConfig> & { id?: unknown };

type ModelsJsonProvider = {
	apiKey?: unknown;
	baseUrl?: unknown;
	models?: ModelsJsonModel[];
};

function providerFromModelsJson(): ModelsJsonProvider | undefined {
	try {
		const modelsPath = join(getAgentDir(), "models.json");
		const config = JSON.parse(stripJsonComments(readFileSync(modelsPath, "utf8"))) as {
			providers?: Record<string, ModelsJsonProvider>;
		};
		return config.providers?.[PROVIDER_ID];
	} catch {
		return undefined;
	}
}

function apiKeyFromModelsJson(): string | undefined {
	const value = providerFromModelsJson()?.apiKey;
	return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function inputFromConfig(value: unknown): ("text" | "image")[] {
	if (!Array.isArray(value)) return ["text"];
	const input = value.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image");
	return input.length > 0 ? input : ["text"];
}

function nonNegativeNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function costFromConfig(value: unknown): ProviderModelConfig["cost"] {
	if (!isRecord(value)) return ZERO_COST;
	return {
		input: nonNegativeNumber(value.input, 0),
		output: nonNegativeNumber(value.output, 0),
		cacheRead: nonNegativeNumber(value.cacheRead, 0),
		cacheWrite: nonNegativeNumber(value.cacheWrite, 0),
	};
}

function modelConfigFromUnknown(value: unknown): ProviderModelConfig | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || value.id.trim().length === 0) return undefined;

	const id = value.id.trim();
	const model: ProviderModelConfig = {
		id,
		name: typeof value.name === "string" && value.name.trim() ? value.name : id,
		reasoning: value.reasoning === true,
		input: inputFromConfig(value.input),
		cost: costFromConfig(value.cost),
		contextWindow: positiveNumber(value.contextWindow, 128000),
		maxTokens: positiveNumber(value.maxTokens, 16384),
	};

	if (typeof value.api === "string") model.api = value.api as ProviderModelConfig["api"];
	if (typeof value.baseUrl === "string" && value.baseUrl.trim()) model.baseUrl = value.baseUrl;
	if (isRecord(value.thinkingLevelMap)) {
		model.thinkingLevelMap = value.thinkingLevelMap as ProviderModelConfig["thinkingLevelMap"];
	}
	if (isRecord(value.headers)) model.headers = value.headers as Record<string, string>;
	if (isRecord(value.compat)) model.compat = value.compat as ProviderModelConfig["compat"];
	return model;
}

function staticModelsFromModelsJson(): ProviderModelConfig[] {
	return (providerFromModelsJson()?.models ?? [])
		.map((model) => modelConfigFromUnknown(model))
		.filter((model): model is ProviderModelConfig => model !== undefined);
}

function modelsFromStored(stored: { models: readonly unknown[] } | undefined): ProviderModelConfig[] {
	return (stored?.models ?? [])
		.map((model) => modelConfigFromUnknown(model))
		.filter((model): model is ProviderModelConfig => model !== undefined);
}

function fallbackCatalog(
	models: ProviderModelConfig[],
	hasProviderBaseUrlOverride: boolean,
): ProviderModelConfig[] {
	if (!hasProviderBaseUrlOverride) return models;
	return models.map(({ baseUrl: _baseUrl, ...model }) => model);
}

function baseUrlFromEnvironment(): string | undefined {
	const value = process.env.PI_9ROUTER_BASE_URL?.trim();
	return value || undefined;
}

function baseUrlFromModelsJson(): string | undefined {
	const value = providerFromModelsJson()?.baseUrl;
	return typeof value === "string" && value.trim() ? value : undefined;
}

function configuredBaseUrlOverride(): string | undefined {
	return baseUrlFromEnvironment() ?? baseUrlFromModelsJson();
}

function configuredBaseUrl(): string {
	return normalizeBaseUrl(configuredBaseUrlOverride());
}

function configuredApiKey(): string | undefined {
	return apiKeyFromEnvironment() ?? apiKeyFromModelsJson();
}

let registeredModels: ProviderModelConfig[] = [];
let registeredBaseUrl = configuredBaseUrl();
let fallbackCatalogSource: "static" | "stored" | "live" | undefined;
let providerRegistered = false;
let lastDiscoveryError: string | undefined;

function registerDynamicProvider(pi: ExtensionAPI, baseUrl: string, initialModels: RouterPiModel[]): void {
	registeredBaseUrl = baseUrl;
	registeredModels = initialModels;
	fallbackCatalogSource = undefined;
	lastDiscoveryError = undefined;

	const apiKey = configuredApiKey();
	pi.registerProvider(PROVIDER_ID, {
		name: "9router",
		baseUrl,
		api: "openai-completions",
		...(apiKey ? { apiKey } : {}),
		models: registeredModels,
		async refreshModels({ allowNetwork, signal }) {
			if (!allowNetwork || signal.aborted) return registeredModels;
			const refreshed = await discoverModels(baseUrl, signal);
			registeredModels = refreshed;
			lastDiscoveryError = undefined;
			return refreshed;
		},
	});
	providerRegistered = true;
}

function registerFallbackProvider(pi: ExtensionAPI): void {
	const configuredBaseUrl = configuredBaseUrlOverride();
	const discoveryBaseUrl = normalizeBaseUrl(configuredBaseUrl);
	registeredBaseUrl = discoveryBaseUrl;
	const hasProviderBaseUrlOverride = configuredBaseUrl !== undefined;
	registeredModels = fallbackCatalog(staticModelsFromModelsJson(), hasProviderBaseUrlOverride);
	fallbackCatalogSource = "static";

	const apiKey = configuredApiKey();
	pi.registerProvider(PROVIDER_ID, {
		name: "9router",
		...(configuredBaseUrl ? { baseUrl: discoveryBaseUrl } : {}),
		api: "openai-completions",
		...(apiKey ? { apiKey } : {}),
		async refreshModels({ allowNetwork, signal, stored }) {
			const storedModels = fallbackCatalog(modelsFromStored(stored), hasProviderBaseUrlOverride);
			const previousModels =
				fallbackCatalogSource !== "static" && registeredModels.length > 0
					? registeredModels
					: storedModels.length > 0
						? storedModels
						: registeredModels.length > 0
							? registeredModels
							: fallbackCatalog(staticModelsFromModelsJson(), hasProviderBaseUrlOverride);

			if (!allowNetwork || signal.aborted) {
				if (storedModels.length > 0 && fallbackCatalogSource === "static") {
					registeredModels = storedModels;
					fallbackCatalogSource = "stored";
				}
				return [...previousModels];
			}

			const refreshed = await discoverModels(discoveryBaseUrl, signal);
			if (signal.aborted) return [...previousModels];

			const staticModels = staticModelsFromModelsJson();
			const models = hasProviderBaseUrlOverride
				? refreshed
				: refreshed.map((model) => {
						const staticModel = staticModels.find((candidate) => candidate.id === model.id);
						return staticModel?.baseUrl
							? { ...model, baseUrl: staticModel.baseUrl }
							: { ...model, baseUrl: discoveryBaseUrl };
					});
			registeredModels = models;
			fallbackCatalogSource = "live";
			lastDiscoveryError = undefined;
			return [...models];
		},
	});
	providerRegistered = true;
}

async function discoverAndRegister(pi: ExtensionAPI): Promise<RouterPiModel[]> {
	const baseUrl = configuredBaseUrl();
	const models = await discoverModels(baseUrl);
	registerDynamicProvider(pi, baseUrl, models);
	return models;
}

function notifyDiscoveryError(error: unknown): void {
	lastDiscoveryError = error instanceof Error ? error.message : String(error);
	console.warn(`9router model discovery skipped: ${lastDiscoveryError}`);
}

export default async function nineRouterPi(pi: ExtensionAPI) {
	pi.registerCommand("9router-pi", {
		description: "Show or refresh the dynamic 9router model catalog",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase() || "status";

			if (command === "refresh") {
				if (process.env.PI_OFFLINE !== undefined) {
					ctx.ui.notify("9router-pi: PI_OFFLINE is set; discovery was skipped.", "warning");
					return;
				}

				try {
					if (!providerRegistered) {
						const models = await discoverAndRegister(pi);
						ctx.ui.notify(`9router-pi: registered ${models.length} model(s).`, "info");
						return;
					}

					const result = await ctx.modelRegistry.refresh({
						providers: [PROVIDER_ID],
						allowNetwork: true,
						force: true,
					});
					const error = result.errors.get(PROVIDER_ID);
					if (error) {
						lastDiscoveryError = error.message;
						ctx.ui.notify(`9router-pi: refresh failed: ${error.message}`, "error");
						return;
					}
					ctx.ui.notify(`9router-pi: refreshed ${registeredModels.length} model(s).`, "info");
				} catch (error) {
					lastDiscoveryError = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`9router-pi: refresh failed: ${lastDiscoveryError}`, "error");
				}
				return;
			}

			if (command === "status") {
				const discovery = lastDiscoveryError ? `last error: ${lastDiscoveryError}` : "discovery ready";
				ctx.ui.notify(
					`9router-pi: ${registeredModels.length} discovered model(s) at ${registeredBaseUrl}; ${discovery}.`,
					"info",
				);
				return;
			}

			if (command === "help") {
				ctx.ui.notify("Usage: /9router-pi [status|refresh|help]", "info");
				return;
			}

			ctx.ui.notify(`9router-pi: unknown command '${command}'. Try /9router-pi help.`, "warning");
		},
	});

	if (process.env.PI_OFFLINE !== undefined) {
		registerFallbackProvider(pi);
		return;
	}

	try {
		await discoverAndRegister(pi);
	} catch (error) {
		notifyDiscoveryError(error);
		// A models.json provider configuration remains available as a static
		// fallback when startup discovery cannot reach the local router.
		registerFallbackProvider(pi);
	}
}
