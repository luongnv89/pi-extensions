import { complete, StringEnum, type CacheRetention, type Message, type Usage } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	convertToLlm,
	serializeConversation,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const STATE_ENTRY = "advisor-pi-state";
const TOOL_NAME = "advisor";
const DEFAULT_ADVISOR_MODEL = "anthropic/claude-opus-4-5";
const DEFAULT_MAX_USES = 3;
const DEFAULT_CACHE_RETENTION: CacheRetention = "short";
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_TOKENS = 4_000;

const advisorToolSchema = Type.Object({
	question: Type.String({
		description:
			"Strategic question for the advisor. Ask for planning, risk analysis, course correction, or review guidance.",
	}),
	phase: Type.Optional(
		StringEnum(["planning", "course_correction", "review", "stuck", "other"] as const, {
			description: "Why the executor is consulting the advisor.",
			default: "other",
		}),
	),
	context: Type.Optional(
		Type.String({
			description:
				"Optional extra context that is not obvious from the transcript, such as constraints, current plan, or failed attempts.",
		}),
	),
});

type AdvisorToolInput = Static<typeof advisorToolSchema>;

type AdvisorConfig = {
	enabled: boolean;
	provider: string;
	modelId: string;
	maxUses: number;
	cacheRetention: CacheRetention;
	maxTokens: number;
	timeoutMs: number;
};

type AdvisorStateEntry = {
	version: 1;
	config: AdvisorConfig;
	useCount: number;
	updatedAt: string;
};

type AdvisorToolDetails = {
	advisor: {
		provider: string;
		model: string;
		phase: string;
		useCount: number;
		maxUses: number;
		cacheRetention: CacheRetention;
		elapsedMs: number;
		stopReason: string;
		usage?: Usage;
	};
	state: AdvisorStateEntry;
};

export default function advisorPiExtension(pi: ExtensionAPI) {
	let config = defaultConfig();
	let useCount = 0;

	pi.registerFlag("advisor-model", {
		description: "Advisor model as provider/model, e.g. anthropic/claude-opus-4-5",
		type: "string",
	});
	pi.registerFlag("advisor-max-uses", {
		description: "Maximum advisor calls per session branch",
		type: "string",
	});
	pi.registerFlag("advisor-cache", {
		description: "Advisor prompt-cache preference: none, short, or long",
		type: "string",
	});
	pi.registerFlag("advisor-enabled", {
		description: "Enable the advisor tool on startup",
		type: "boolean",
		default: true,
	});

	pi.registerTool<typeof advisorToolSchema, AdvisorToolDetails>({
		name: TOOL_NAME,
		label: "Advisor",
		description:
			"Consult a configured higher-capability advisor model for strategic guidance during complex agent tasks. The advisor reads the current conversation transcript and returns planning, risk, or course-correction advice. It has no tools and does not modify files.",
		promptSnippet:
			"Consult a higher-capability advisor model for strategic planning, risk checks, and course correction on complex tasks.",
		promptGuidelines: [
			"Use advisor before starting a complex, multi-step, or high-risk task when strategic planning would reduce mistakes.",
			"Use advisor when stuck, when tests keep failing, or when choosing between competing implementation approaches.",
			"Do not use advisor for simple lookups, trivial edits, or when the user explicitly wants the fastest possible answer.",
		],
		parameters: advisorToolSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			refreshStateFromBranch(ctx);

			if (!config.enabled) {
				return advisorDisabledResult(config, useCount, params);
			}

			if (useCount >= config.maxUses) {
				return advisorLimitResult(config, useCount, params);
			}

			const model = ctx.modelRegistry.find(config.provider, config.modelId);
			if (!model) {
				throw new Error(
					`Advisor model not found: ${config.provider}/${config.modelId}. Run /advisor-pi model <provider>/<model>.`,
				);
			}

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Consulting advisor ${config.provider}/${config.modelId}...`,
					},
				],
				details: makeSkippedDetails(config, useCount, params),
			});

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error(auth.error);

			const startedAt = Date.now();
			const conversationText = serializeCurrentConversation(ctx);
			const userMessage: Message = {
				role: "user",
				content: [
					{
						type: "text",
						text: buildAdvisorUserPrompt(params, conversationText),
					},
				],
				timestamp: Date.now(),
			};

			const response = await complete(
				model,
				{
					systemPrompt: ADVISOR_SYSTEM_PROMPT,
					messages: [userMessage],
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					signal,
					cacheRetention: config.cacheRetention,
					sessionId: `advisor-pi:${ctx.sessionManager.getSessionId()}`,
					maxTokens: config.maxTokens,
					timeoutMs: config.timeoutMs,
				},
			);

			if (response.stopReason === "error") {
				throw new Error(response.errorMessage ?? "Advisor model returned an error");
			}
			if (response.stopReason === "aborted") {
				throw new Error("Advisor call aborted");
			}

			useCount += 1;
			persistState(pi, config, useCount);
			updateStatus(ctx);

			const elapsedMs = Date.now() - startedAt;
			const text = extractText(response.content) || "Advisor returned no text guidance.";
			const details: AdvisorToolDetails = {
				advisor: {
					provider: response.provider,
					model: response.model,
					phase: params.phase ?? "other",
					useCount,
					maxUses: config.maxUses,
					cacheRetention: config.cacheRetention,
					elapsedMs,
					stopReason: response.stopReason,
					usage: response.usage,
				},
				state: makeStateEntry(config, useCount),
			};

			return {
				content: [
					{
						type: "text",
						text: `Advisor guidance (${useCount}/${config.maxUses}, ${config.provider}/${config.modelId}):\n\n${text}`,
					},
				],
				details,
			};
		},
	});

	pi.registerCommand("advisor-pi", {
		description: "Configure advisor-pi: status, enable, disable, model, max-uses, cache, reset",
		handler: async (args, ctx) => {
			const result = handleCommand(args.trim(), ctx);
			if (result.persist) persistState(pi, config, useCount);
			if (result.updateToolState) syncActiveTool(pi);
			updateStatus(ctx);
			ctx.ui.notify(result.message, result.level);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		refreshStateFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		refreshStateFromBranch(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		if (!config.enabled) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildExecutorGuidance(config, useCount)}`,
		};
	});

	pi.on("turn_start", async () => {
		persistState(pi, config, useCount);
	});

	function refreshStateFromBranch(ctx: ExtensionContext): void {
		config = defaultConfig();
		useCount = 0;
		const restoredFromBranch = restoreStateFromSession(ctx);
		if (!restoredFromBranch) applyStartupFlags(pi);
		syncActiveTool(pi);
		updateStatus(ctx);
	}

	function restoreStateFromSession(ctx: ExtensionContext): boolean {
		let restored = false;
		const branch = ctx.sessionManager.getBranch();
		for (const entry of branch) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
				restored = true;
				const data = entry.data as Partial<AdvisorStateEntry> | undefined;
				if (data?.config) config = normalizeConfig(data.config, config);
				if (typeof data?.useCount === "number") useCount = Math.max(0, data.useCount);
			}
			if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === TOOL_NAME) {
				restored = true;
				const details = entry.message.details as Partial<AdvisorToolDetails> | undefined;
				if (details?.state?.config) config = normalizeConfig(details.state.config, config);
				if (typeof details?.state?.useCount === "number") useCount = Math.max(useCount, details.state.useCount);
				else if (details?.advisor?.useCount) useCount = Math.max(useCount, details.advisor.useCount);
			}
		}
		return restored;
	}

	function applyStartupFlags(api: ExtensionAPI): void {
		const enabledFlag = api.getFlag("advisor-enabled");
		if (typeof enabledFlag === "boolean") config.enabled = enabledFlag;

		const modelFlag = api.getFlag("advisor-model");
		if (typeof modelFlag === "string" && modelFlag.trim()) {
			const parsed = parseModelSpec(modelFlag.trim());
			if (parsed) {
				config.provider = parsed.provider;
				config.modelId = parsed.modelId;
			}
		}

		const maxUsesFlag = api.getFlag("advisor-max-uses");
		if (typeof maxUsesFlag === "string") {
			const maxUses = parsePositiveInt(maxUsesFlag);
			if (maxUses !== undefined) config.maxUses = maxUses;
		}

		const cacheFlag = api.getFlag("advisor-cache");
		if (typeof cacheFlag === "string") {
			const cacheRetention = parseCacheRetention(cacheFlag);
			if (cacheRetention) config.cacheRetention = cacheRetention;
		}
	}

	function handleCommand(
		args: string,
		ctx: ExtensionContext,
	): { message: string; level: "info" | "warning" | "error"; persist: boolean; updateToolState: boolean } {
		if (!args || args === "status") {
			return {
				message: formatStatus(ctx),
				level: "info",
				persist: false,
				updateToolState: false,
			};
		}

		const [command, ...rest] = args.split(/\s+/);
		const value = rest.join(" ").trim();

		switch (command) {
			case "enable":
				config.enabled = true;
				return { message: "advisor-pi enabled", level: "info", persist: true, updateToolState: true };
			case "disable":
				config.enabled = false;
				return { message: "advisor-pi disabled", level: "info", persist: true, updateToolState: true };
			case "reset":
				useCount = 0;
				return { message: "advisor-pi use count reset", level: "info", persist: true, updateToolState: false };
			case "model": {
				const parsed = parseModelSpec(value);
				if (!parsed) {
					return {
						message: "Usage: /advisor-pi model <provider>/<model>",
						level: "error",
						persist: false,
						updateToolState: false,
					};
				}
				const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
				if (!model) {
					return {
						message: `Advisor model not found: ${parsed.provider}/${parsed.modelId}`,
						level: "error",
						persist: false,
						updateToolState: false,
					};
				}
				config.provider = parsed.provider;
				config.modelId = parsed.modelId;
				return {
					message: `advisor-pi model set to ${config.provider}/${config.modelId}`,
					level: "info",
					persist: true,
					updateToolState: false,
				};
			}
			case "max-uses": {
				const maxUses = parsePositiveInt(value);
				if (maxUses === undefined) {
					return {
						message: "Usage: /advisor-pi max-uses <positive-number>",
						level: "error",
						persist: false,
						updateToolState: false,
					};
				}
				config.maxUses = maxUses;
				return {
					message: `advisor-pi max uses set to ${maxUses}`,
					level: "info",
					persist: true,
					updateToolState: false,
				};
			}
			case "cache": {
				const cacheRetention = parseCacheRetention(value);
				if (!cacheRetention) {
					return {
						message: "Usage: /advisor-pi cache <none|short|long>",
						level: "error",
						persist: false,
						updateToolState: false,
					};
				}
				config.cacheRetention = cacheRetention;
				return {
					message: `advisor-pi cache set to ${cacheRetention}`,
					level: "info",
					persist: true,
					updateToolState: false,
				};
			}
			default:
				return {
					message:
						"Usage: /advisor-pi [status|enable|disable|model <provider>/<model>|max-uses <n>|cache <none|short|long>|reset]",
					level: "error",
					persist: false,
					updateToolState: false,
				};
		}
	}

	function syncActiveTool(api: ExtensionAPI): void {
		const activeTools = api.getActiveTools();
		const hasAdvisor = activeTools.includes(TOOL_NAME);
		if (config.enabled && !hasAdvisor) {
			api.setActiveTools([...activeTools, TOOL_NAME]);
		} else if (!config.enabled && hasAdvisor) {
			api.setActiveTools(activeTools.filter((tool) => tool !== TOOL_NAME));
		}
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!config.enabled) {
			ctx.ui.setStatus("advisor-pi", undefined);
			return;
		}
		const remaining = Math.max(0, config.maxUses - useCount);
		ctx.ui.setStatus("advisor-pi", ctx.ui.theme.fg(remaining > 0 ? "accent" : "warning", `advisor:${remaining}`));
	}

	function formatStatus(ctx: ExtensionContext): string {
		const model = ctx.modelRegistry.find(config.provider, config.modelId);
		const availability = model ? "available" : "not found";
		return [
			`advisor-pi ${config.enabled ? "enabled" : "disabled"}`,
			`model: ${config.provider}/${config.modelId} (${availability})`,
			`uses: ${useCount}/${config.maxUses}`,
			`cache: ${config.cacheRetention}`,
		].join(" • ");
	}
}

const ADVISOR_SYSTEM_PROMPT = `You are an advisor model for Pi Coding Agent.

Your role is strategic guidance only. You do not have tools and you do not make changes. Given the executor's question and conversation transcript:

- Identify the best next plan or course correction.
- Call out risks, missing information, edge cases, and test strategy.
- Prefer concise, actionable guidance the executor can apply immediately.
- Do not restate the full transcript.
- If the task is unsafe, impossible, or underspecified, say what must be clarified.

Return guidance in short sections with bullets when useful.`;

function defaultConfig(): AdvisorConfig {
	const parsed = parseModelSpec(DEFAULT_ADVISOR_MODEL) ?? { provider: "anthropic", modelId: "claude-opus-4-5" };
	return {
		enabled: true,
		provider: parsed.provider,
		modelId: parsed.modelId,
		maxUses: DEFAULT_MAX_USES,
		cacheRetention: DEFAULT_CACHE_RETENTION,
		maxTokens: DEFAULT_MAX_TOKENS,
		timeoutMs: DEFAULT_TIMEOUT_MS,
	};
}

function buildExecutorGuidance(config: AdvisorConfig, useCount: number): string {
	const remaining = Math.max(0, config.maxUses - useCount);
	return [
		"Advisor-pi is enabled.",
		`The advisor tool consults ${config.provider}/${config.modelId} for strategic guidance and has ${remaining}/${config.maxUses} uses remaining on this branch.`,
		"Use advisor for complex planning, risky implementation choices, repeated failures, or course correction. Do not use advisor for trivial edits or simple facts.",
		`Advisor cache preference is ${config.cacheRetention}; caching support is provider-dependent.`,
	].join("\n");
}

function serializeCurrentConversation(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getEntries();
	const leafId = ctx.sessionManager.getLeafId();
	const sessionContext = buildSessionContext(entries, leafId);
	const llmMessages = convertToLlm(sessionContext.messages);
	return serializeConversation(llmMessages);
}

function buildAdvisorUserPrompt(params: AdvisorToolInput, conversationText: string): string {
	return [
		"## Executor Question",
		params.question,
		"",
		"## Consultation Phase",
		params.phase ?? "other",
		"",
		...(params.context ? ["## Extra Context", params.context, ""] : []),
		"## Conversation Transcript",
		conversationText,
	].join("\n");
}

function extractText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function advisorDisabledResult(config: AdvisorConfig, useCount: number, params: AdvisorToolInput) {
	return {
		content: [
			{
				type: "text" as const,
				text: `advisor-pi is disabled. The executor should continue without advisor guidance for: ${params.question}`,
			},
		],
		details: makeSkippedDetails(config, useCount, params),
	};
}

function advisorLimitResult(config: AdvisorConfig, useCount: number, params: AdvisorToolInput) {
	return {
		content: [
			{
				type: "text" as const,
				text: `Advisor use limit reached. The executor should continue without another advisor call for: ${params.question}`,
			},
		],
		details: makeSkippedDetails(config, useCount, params),
	};
}

function makeSkippedDetails(config: AdvisorConfig, useCount: number, params: AdvisorToolInput): AdvisorToolDetails {
	return {
		advisor: {
			provider: config.provider,
			model: config.modelId,
			phase: params.phase ?? "other",
			useCount,
			maxUses: config.maxUses,
			cacheRetention: config.cacheRetention,
			elapsedMs: 0,
			stopReason: "skipped",
		},
		state: makeStateEntry(config, useCount),
	};
}

function makeStateEntry(config: AdvisorConfig, useCount: number): AdvisorStateEntry {
	return {
		version: 1,
		config: { ...config },
		useCount,
		updatedAt: new Date().toISOString(),
	};
}

function persistState(pi: ExtensionAPI, config: AdvisorConfig, useCount: number): void {
	pi.appendEntry(STATE_ENTRY, makeStateEntry(config, useCount));
}

function normalizeConfig(input: Partial<AdvisorConfig>, fallback: AdvisorConfig): AdvisorConfig {
	return {
		enabled: typeof input.enabled === "boolean" ? input.enabled : fallback.enabled,
		provider: typeof input.provider === "string" && input.provider ? input.provider : fallback.provider,
		modelId: typeof input.modelId === "string" && input.modelId ? input.modelId : fallback.modelId,
		maxUses: typeof input.maxUses === "number" && input.maxUses > 0 ? Math.floor(input.maxUses) : fallback.maxUses,
		cacheRetention: parseCacheRetention(input.cacheRetention) ?? fallback.cacheRetention,
		maxTokens: typeof input.maxTokens === "number" && input.maxTokens > 0 ? Math.floor(input.maxTokens) : fallback.maxTokens,
		timeoutMs: typeof input.timeoutMs === "number" && input.timeoutMs > 0 ? Math.floor(input.timeoutMs) : fallback.timeoutMs,
	};
}

function parseModelSpec(value: string): { provider: string; modelId: string } | undefined {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	return {
		provider: value.slice(0, slash),
		modelId: value.slice(slash + 1),
	};
}

function parsePositiveInt(value: string): number | undefined {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
	return parsed;
}

function parseCacheRetention(value: unknown): CacheRetention | undefined {
	if (value === "none" || value === "short" || value === "long") return value;
	return undefined;
}

