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
	cost: ProviderModelConfig["cost"];
	contextWindow: number;
	maxTokens: number;
	compat?: ProviderModelConfig["compat"];
};

function isFreeModel(id: string): boolean {
	return id.endsWith(":free");
}

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

export function normalizeModels(
	payload: RouterModelsResponse,
	options?: { freeOnly?: boolean },
): RouterPiModel[] {
	const freeOnly = options?.freeOnly ?? true;
	const seen = new Set<string>();
	const models: RouterPiModel[] = [];

	for (const model of payload.data ?? []) {
		if (!hasModelId(model)) continue;
		const id = model.id.trim();
		if (seen.has(id)) continue;
		seen.add(id);

		if (freeOnly && !isFreeModel(id)) continue;

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

	const apiKey = configuredApiKey();
	const headers: Record<string, string> = {};
	if (apiKey) {
		headers["Authorization"] = `Bearer ${apiKey}`;
	}

	try {
		const response = await fetch(`${baseUrl}/models`, { signal: controller.signal, headers });
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
	options?: { freeOnly?: boolean },
): Promise<RouterPiModel[]> {
	const freeOnly = options?.freeOnly ?? configuredFreeOnly();
	const models = normalizeModels(await fetchPayload(normalizeBaseUrl(baseUrl), signal), { freeOnly });
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
	compat?: unknown;
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
	if (!isRecord(value)) return { ...ZERO_COST };
	const cost = structuredClone(value) as Record<string, unknown>;
	return {
		...cost,
		input: nonNegativeNumber(cost.input, 0),
		output: nonNegativeNumber(cost.output, 0),
		cacheRead: nonNegativeNumber(cost.cacheRead, 0),
		cacheWrite: nonNegativeNumber(cost.cacheWrite, 0),
	} as ProviderModelConfig["cost"];
}

function compatFromConfig(value: unknown): ProviderModelConfig["compat"] | undefined {
	return isRecord(value) ? (structuredClone(value) as ProviderModelConfig["compat"]) : undefined;
}

function modelConfigFromUnknown(value: unknown): ProviderModelConfig | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || value.id.trim().length === 0) return undefined;

	const model = structuredClone(value) as Record<string, unknown>;
	const id = (value.id as string).trim();
	model.id = id;
	model.name = typeof value.name === "string" && value.name.trim() ? value.name : id;
	model.reasoning = value.reasoning === true;
	model.input = inputFromConfig(value.input);
	model.cost = costFromConfig(value.cost);
	model.contextWindow = positiveNumber(value.contextWindow, 128000);
	model.maxTokens = positiveNumber(value.maxTokens, 16384);
	if (typeof value.api !== "string") delete model.api;
	if (typeof value.baseUrl !== "string" || !value.baseUrl.trim()) delete model.baseUrl;
	if (!isRecord(value.thinkingLevelMap)) delete model.thinkingLevelMap;
	if (!isRecord(value.headers)) delete model.headers;
	if (!isRecord(value.compat)) delete model.compat;
	return model as unknown as ProviderModelConfig;
}

function providerCompatFromModelsJson(): ProviderModelConfig["compat"] | undefined {
	return compatFromConfig(providerFromModelsJson()?.compat);
}

function applyProviderCompat(
	models: readonly ProviderModelConfig[],
	providerCompat = providerCompatFromModelsJson(),
): ProviderModelConfig[] {
	return models.map((model) => {
		const cloned = structuredClone(model);
		if (!providerCompat) return cloned;
		const modelCompat = compatFromConfig(cloned.compat);
		return {
			...cloned,
			compat: { ...providerCompat, ...modelCompat },
		};
	});
}

function staticModelsFromModelsJson(): ProviderModelConfig[] {
	return applyProviderCompat(
		(providerFromModelsJson()?.models ?? [])
			.map((model) => modelConfigFromUnknown(model))
			.filter((model): model is ProviderModelConfig => model !== undefined),
	);
}

function modelsFromStored(stored: { models: readonly unknown[] } | undefined): ProviderModelConfig[] {
	return applyProviderCompat(
		(stored?.models ?? [])
			.map((model) => modelConfigFromUnknown(model))
			.filter((model): model is ProviderModelConfig => model !== undefined),
	);
}

function fallbackCatalog(
	models: ProviderModelConfig[],
	hasProviderBaseUrlOverride: boolean,
): ProviderModelConfig[] {
	return models.map((model) => {
		const cloned = structuredClone(model);
		if (hasProviderBaseUrlOverride) delete cloned.baseUrl;
		return cloned;
	});
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

function configuredFreeOnly(): boolean {
	const value = process.env.PI_9ROUTER_FREE_ONLY;
	if (value === undefined) return true;
	return value !== "0" && value !== "false" && value !== "";
}

function hasConfiguredString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

type PanelAuthSource = "environment" | "models.json" | "runtime" | "stored" | "provider config" | "unknown";

function configuredApiKeySource(): "environment" | "models.json" | "not configured" {
	if (hasConfiguredString(process.env.NINE_ROUTER_API_KEY)) return "environment";
	if (hasConfiguredString(providerFromModelsJson()?.apiKey)) return "models.json";
	return "not configured";
}

function configuredBaseUrlSource(): "environment" | "models.json" | "default" {
	if (hasConfiguredString(process.env.PI_9ROUTER_BASE_URL)) return "environment";
	if (hasConfiguredString(providerFromModelsJson()?.baseUrl)) return "models.json";
	return "default";
}

function panelAuthSource(value: unknown): PanelAuthSource {
	switch (value) {
		case "environment":
			return "environment";
		case "models_json_key":
		case "models_json_command":
			return "models.json";
		case "runtime":
			return "runtime";
		case "stored":
			return "stored";
		case "fallback":
			return "provider config";
		default:
			return "unknown";
	}
}

function panelProviderAuth(ctx: any): { configured: boolean; source: PanelAuthSource } {
	try {
		const status = ctx.modelRegistry.getProviderAuthStatus(PROVIDER_ID);
		const source = status?.configured ? panelAuthSource(status.source) : "unknown";
		const configuredSource = configuredApiKeySource();
		return {
			configured: status?.configured === true,
			source: source === "provider config" && configuredSource !== "not configured" ? configuredSource : source,
		};
	} catch {
		const source = configuredApiKeySource();
		return {
			configured: source !== "not configured",
			source: source === "models.json" || source === "environment" ? source : "unknown",
		};
	}
}

type ExtensionState = {
	registeredModels: ProviderModelConfig[];
	registeredBaseUrl: string;
	fallbackCatalogSource: "static" | "stored" | "live" | undefined;
	providerRegistered: boolean;
	lastDiscoveryError: string | undefined;
};

function createExtensionState(): ExtensionState {
	return {
		registeredModels: [],
		registeredBaseUrl: configuredBaseUrl(),
		fallbackCatalogSource: undefined,
		providerRegistered: false,
		lastDiscoveryError: undefined,
	};
}

function panelCatalogSource(state: ExtensionState): string {
	if (!state.providerRegistered) return "not registered";
	switch (state.fallbackCatalogSource) {
		case "static":
			return "models.json static catalog";
		case "stored":
			return "stored catalog";
		case "live":
			return "live discovery";
		default:
			return "live discovery";
	}
}

function panelAvailableModelCount(ctx: any): number | undefined {
	try {
		return ctx.modelRegistry.getAvailable().filter((model: any) => model.provider === PROVIDER_ID).length;
	} catch {
		return undefined;
	}
}

function panelProviderStatusLines(ctx: any, state: ExtensionState): string[] {
	const auth = panelProviderAuth(ctx);
	return [
		`Provider: ${state.providerRegistered ? "registered" : "not registered"}`,
		`Authentication: ${auth.configured ? "configured" : "not configured"}`,
		`Authentication source: ${auth.configured ? auth.source : "none"}`,
		`Discovery: ${state.lastDiscoveryError ? "last attempt failed (details hidden)" : state.providerRegistered ? "ready" : "not started"}`,
		`Catalog source: ${panelCatalogSource(state)}`,
		`Registered models: ${state.registeredModels.length}`,
	];
}

function panelConfigurationLines(): string[] {
	const provider = providerFromModelsJson();
	const apiKeySource = configuredApiKeySource();
	const baseUrlSource = configuredBaseUrlSource();
	const staticModelCount = Array.isArray(provider?.models) ? provider.models.length : 0;
	return [
		`Gateway URL: ${baseUrlSource === "default" ? "default" : `${baseUrlSource} override present`}`,
		`API key: ${apiKeySource === "not configured" ? "not configured" : `present via ${apiKeySource}`}`,
		`models.json provider: ${provider ? "present" : "not present"}`,
		`models.json static models: ${staticModelCount}`,
		`Free-only filter: ${configuredFreeOnly() ? "enabled" : "disabled"}`,
	];
}

function panelModelLines(ctx: any, state: ExtensionState): string[] {
	const availableCount = panelAvailableModelCount(ctx);
	return [
		`Catalog source: ${panelCatalogSource(state)}`,
		`Registered models: ${state.registeredModels.length}`,
		availableCount === undefined
			? "Registry availability: unavailable"
			: `Registry availability: ${availableCount} model(s)`,
		"Model IDs hidden for safety; registry availability is shown as a count.",
	];
}

function panelHelpLines(): string[] {
	return [
		"Read-only view: no refresh, update, test, login, model calls, or configuration edits.",
		"Use Up/Down to navigate and Enter to inspect a section.",
		"Use Back to return to the sections, or Close/Escape to leave the panel.",
		"Explicit /9router-pi status, refresh, and help commands are unchanged.",
	];
}

const PANEL_CLOSE = "Close";
const PANEL_BACK = "Back";
const PANEL_SECTIONS = ["Provider status", "Configuration (source presence)", "Models (registered/available)", "Help / navigation"] as const;

type PanelSection = (typeof PANEL_SECTIONS)[number];

export async function showPanelList(ctx: any, title: string, lines: string[]): Promise<string | undefined> {
	// The built-in selector has no height limit. Keep each ASCII detail to at most two rows at 40 columns.
	const records = (lines.length ? lines : ["No details available."]).flatMap((line) =>
		line ? Array.from({ length: Math.ceil(line.length / 40) }, (_, index) => line.slice(index * 40, (index + 1) * 40)) : [""],
	);
	let page = 0;
	for (;;) {
		const detail = `• ${records[page]}`;
		const options = [
			detail,
			...(page > 0 ? ["Previous"] : []),
			...(page < records.length - 1 ? ["Next"] : []),
			PANEL_BACK,
			PANEL_CLOSE,
		];
		const counter = ` (${page + 1}/${records.length})`;
		let heading = title;
		if (heading.length + counter.length > 38) heading = heading.replace(/\s+\([^()]*\)$/u, "");
		if (heading.length + counter.length > 38) heading = heading.slice(0, Math.min(30, 38 - counter.length));
		const choice = await ctx.ui.select(`${heading}${counter}`, options);
		if (choice === undefined || choice === PANEL_CLOSE || choice === PANEL_BACK) return choice;
		if (choice === "Previous" && page > 0) page -= 1;
		if (choice === "Next" && page < records.length - 1) page += 1;
	}
}

async function openReadOnlyPanel(ctx: any, state: ExtensionState): Promise<void> {
	for (;;) {
		const choice = await ctx.ui.select("9router-pi (read-only)", [...PANEL_SECTIONS, PANEL_CLOSE]);
		if (choice === undefined || choice === PANEL_CLOSE) return;
		if (!PANEL_SECTIONS.includes(choice as PanelSection)) return;

		const section = choice as PanelSection;
		const lines =
			section === "Provider status"
				? panelProviderStatusLines(ctx, state)
				: section === "Configuration (source presence)"
					? panelConfigurationLines()
					: section === "Models (registered/available)"
						? panelModelLines(ctx, state)
						: panelHelpLines();
		const detailChoice = await showPanelList(ctx, `9router-pi: ${section}`, lines);
		if (detailChoice === undefined || detailChoice === PANEL_CLOSE) return;
	}
}

function registerDynamicProvider(
	pi: ExtensionAPI,
	baseUrl: string,
	initialModels: RouterPiModel[],
	state: ExtensionState,
): void {
	state.registeredBaseUrl = baseUrl;
	state.registeredModels = applyProviderCompat(initialModels);
	state.fallbackCatalogSource = undefined;
	state.lastDiscoveryError = undefined;

	const apiKey = configuredApiKey();
	pi.registerProvider(PROVIDER_ID, {
		name: "9router",
		baseUrl,
		api: "openai-completions",
		...(apiKey ? { apiKey } : {}),
		models: state.registeredModels,
		async refreshModels({ allowNetwork, signal, publish }) {
			const previousModels = state.registeredModels;
			if (!allowNetwork || signal.aborted) return [...previousModels];
			const refreshed = await discoverModels(baseUrl, signal);
			if (signal.aborted) return [...previousModels];
			const candidate = applyProviderCompat(refreshed);
			const accepted = await publish({
				update: () => {
					state.registeredModels = candidate;
					state.lastDiscoveryError = undefined;
				},
			});
			return accepted ? [...candidate] : [...previousModels];
		},
	});
	state.providerRegistered = true;
}

function registerFallbackProvider(pi: ExtensionAPI, state: ExtensionState): void {
	const configuredBaseUrl = configuredBaseUrlOverride();
	const discoveryBaseUrl = normalizeBaseUrl(configuredBaseUrl);
	state.registeredBaseUrl = discoveryBaseUrl;
	const hasProviderBaseUrlOverride = configuredBaseUrl !== undefined;
	state.registeredModels = fallbackCatalog(staticModelsFromModelsJson(), hasProviderBaseUrlOverride);
	state.fallbackCatalogSource = "static";

	const apiKey = configuredApiKey();
	pi.registerProvider(PROVIDER_ID, {
		name: "9router",
		...(configuredBaseUrl ? { baseUrl: discoveryBaseUrl } : {}),
		api: "openai-completions",
		...(apiKey ? { apiKey } : {}),
		async refreshModels({ allowNetwork, signal, stored, publish }) {
			const storedModels = fallbackCatalog(modelsFromStored(stored), hasProviderBaseUrlOverride);
			const previousModels = state.registeredModels;

			if (signal.aborted) return [...previousModels];
			if (!allowNetwork) {
				if (storedModels.length > 0 && state.fallbackCatalogSource === "static") {
					const accepted = await publish({
						update: () => {
							state.registeredModels = storedModels;
							state.fallbackCatalogSource = "stored";
						},
					});
					return accepted ? [...storedModels] : [...previousModels];
				}
				return [...previousModels];
			}

			const refreshed = await discoverModels(discoveryBaseUrl, signal);
			if (signal.aborted) return [...previousModels];

			const staticModels = staticModelsFromModelsJson();
			const models = hasProviderBaseUrlOverride
				? applyProviderCompat(refreshed)
				: applyProviderCompat(refreshed).map((model) => {
						const staticModel = staticModels.find((candidate) => candidate.id === model.id);
						return staticModel?.baseUrl
						? { ...model, baseUrl: staticModel.baseUrl }
						: { ...model, baseUrl: discoveryBaseUrl };
					});
			const accepted = await publish({
				update: () => {
					state.registeredModels = models;
					state.fallbackCatalogSource = "live";
					state.lastDiscoveryError = undefined;
				},
			});
			return accepted ? [...models] : [...previousModels];
		},
	});
	state.providerRegistered = true;
}

async function discoverAndRegister(pi: ExtensionAPI, state: ExtensionState): Promise<RouterPiModel[]> {
	const baseUrl = configuredBaseUrl();
	const models = await discoverModels(baseUrl, undefined, { freeOnly: configuredFreeOnly() });
	const registeredModels = applyProviderCompat(models);
	registerDynamicProvider(pi, baseUrl, registeredModels, state);
	return registeredModels;
}

function notifyDiscoveryError(state: ExtensionState, error: unknown): void {
	state.lastDiscoveryError = error instanceof Error ? error.message : String(error);
	console.warn(`9router model discovery skipped: ${state.lastDiscoveryError}`);
}

export default async function nineRouterPi(pi: ExtensionAPI) {
	const state = createExtensionState();
	pi.registerCommand("9router-pi", {
		description: "Show or refresh the dynamic 9router model catalog",
		handler: async (args, ctx) => {
			const trimmedArgs = args.trim();
			if (!trimmedArgs && ctx.mode === "tui" && ctx.hasUI) {
				await openReadOnlyPanel(ctx, state);
				return;
			}
			const command = trimmedArgs.toLowerCase() || "status";

			if (command === "refresh") {
				if (process.env.PI_OFFLINE !== undefined) {
					ctx.ui.notify("9router-pi: PI_OFFLINE is set; discovery was skipped.", "warning");
					return;
				}

				try {
					if (!state.providerRegistered) {
						const models = await discoverAndRegister(pi, state);
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
						state.lastDiscoveryError = error.message;
						ctx.ui.notify(`9router-pi: refresh failed: ${error.message}`, "error");
						return;
					}
					ctx.ui.notify(`9router-pi: refreshed ${state.registeredModels.length} model(s).`, "info");
				} catch (error) {
					state.lastDiscoveryError = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`9router-pi: refresh failed: ${state.lastDiscoveryError}`, "error");
				}
				return;
			}

			if (command === "status") {
				const discovery = state.lastDiscoveryError ? `last error: ${state.lastDiscoveryError}` : "discovery ready";
				ctx.ui.notify(
					`9router-pi: ${state.registeredModels.length} discovered model(s) at ${state.registeredBaseUrl}; ${discovery}.`,
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
		registerFallbackProvider(pi, state);
		return;
	}

	try {
		await discoverAndRegister(pi, state);
	} catch (error) {
		notifyDiscoveryError(state, error);
		// A models.json provider configuration remains available as a static
		// fallback when startup discovery cannot reach the local router.
		registerFallbackProvider(pi, state);
	}
}
