import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
	defaultConfig,
	defaultStats,
	formatModelSpec,
	type FusionConfig,
	type FusionStateEntry,
	type FusionStats,
	modelResolves,
	type ModelSpec,
	normalizeConfig,
	normalizeStats,
	parseBoolean,
	parseModelSpec,
	parsePositiveInt,
	parseThinkingLevel,
	parseToolMode,
	resolveSidekickModel,
	type SidekickToolMode,
	toolsForMode,
} from "./config.js";
import { addTokens, counterfactualCost, diffTokens, formatSavings, formatTokens, formatUsd } from "./metrics.js";
import {
	buildMenuRows,
	buildModelRows,
	buildProviderRows,
	CLEAR_LABEL,
	MANUAL_ENTRY_LABEL,
	type MenuKey,
	type ModelOrder,
	rowForLabel,
} from "./config-ui.js";
import { type IdleState, showIdle, showRunning, shortModelName } from "./indicator.js";
import { decideRoute, type RouteDecision } from "./router.js";
import {
	buildDelegationPrompt,
	createSidekickSession,
	runDelegation,
	sidekickKey,
	type SidekickHandle,
} from "./sidekick.js";

export const STATE_ENTRY = "pi-fusion-state";
const TOOL_NAME = "delegate";

// Every field here is re-sent on each turn, so descriptions stay terse: the
// benchmark traced most of a small task's regression to this fixed overhead.
const delegateToolSchema = Type.Object({
	task: Type.String({ description: "Self-contained unit of work: what to do, and where." }),
	context: Type.Optional(
		Type.String({ description: "Plan, constraints, and decisions the sidekick cannot see." }),
	),
	expect: Type.Optional(Type.String({ description: "What to report back." })),
});

type DelegateToolInput = Static<typeof delegateToolSchema>;

type DelegateToolDetails = {
	fusion: {
		sidekick: string;
		toolMode: SidekickToolMode;
		delegations: number;
		maxDelegations: number;
		elapsedMs: number;
		ok: boolean;
		tokens: FusionStats["tokens"];
		cost: number;
		counterfactual: number;
		reusedContext: boolean;
		usage?: Usage;
	};
	state: FusionStateEntry;
};

export default function piFusionExtension(pi: ExtensionAPI) {
	let config = defaultConfig();
	let stats = defaultStats();
	let handle: SidekickHandle | undefined;
	let baselineModel: ModelSpec | undefined;
	let liveMainModel: ModelSpec | undefined;
	let activeDelegation: { spec: ModelSpec; startedAt: number } | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;

	pi.registerFlag("fusion-enabled", {
		description: "Enable the fusion sidekick on startup",
		type: "boolean",
		default: true,
	});
	pi.registerFlag("fusion-sidekick", {
		description: "Sidekick model as provider/model, e.g. openai-codex/gpt-5.4-mini",
		type: "string",
	});
	pi.registerFlag("fusion-sidekick-upgrade", {
		description: "Stronger sidekick model tried before escalating the main agent",
		type: "string",
	});
	pi.registerFlag("fusion-frontier", {
		description: "Main-agent escalation target as provider/model",
		type: "string",
	});
	pi.registerFlag("fusion-tools", {
		description: "Sidekick tool mode: readonly (default) or coding (adds edit, write, bash)",
		type: "string",
	});
	pi.registerFlag("fusion-thinking", {
		description: "Sidekick thinking level: off, minimal, low, medium, high, or xhigh",
		type: "string",
	});
	pi.registerFlag("fusion-max-delegations", {
		description: "Maximum delegations per session branch",
		type: "string",
	});
	pi.registerFlag("fusion-routing", {
		description: "Enable compaction-boundary model routing",
		type: "boolean",
		default: false,
	});

	pi.registerTool<typeof delegateToolSchema, DelegateToolDetails>({
		name: TOOL_NAME,
		label: "Delegate",
		description:
			"Hand a unit of execution work to a cheaper sidekick agent with its own tools and persistent context.",
		promptSnippet: "Delegate slow or bulky execution work to a cheaper sidekick agent.",
		promptGuidelines: [
			"Delegate work whose output is bulky or repetitive - a test suite, a wide search, a sweep across many files. A single command that prints hundreds of lines is worth delegating: that output lands in the sidekick's context instead of yours.",
			"Do not delegate a lookup whose answer is a line or two, and never delegate when the judgment is the deliverable.",
			"The sidekick cannot see this conversation. Put the plan and constraints in `context`, and review what comes back.",
		],
		parameters: delegateToolSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			refreshStateFromBranch(ctx);

			if (!config.enabled) {
				return skipResult(`pi-fusion is disabled. Do this task yourself: ${params.task}`, params, false);
			}
			if (stats.delegations >= config.maxDelegations) {
				return skipResult(
					`Delegation budget exhausted (${stats.delegations}/${config.maxDelegations}). Do this task yourself: ${params.task}`,
					params,
					false,
				);
			}

			captureBaselineIfUnset(ctx);
			const spec = activeSidekickSpec();
			const model = ctx.modelRegistry.find(spec.provider, spec.modelId);
			if (!model) {
				throw new Error(
					`Sidekick model not found: ${formatModelSpec(spec)}. Run /fusion sidekick <provider>/<model>.`,
				);
			}

			const wantedKey = sidekickKey(spec, config.toolMode, config.thinkingLevel);
			const reusedContext = handle?.key === wantedKey;
			if (!reusedContext) dropSidekick();

			onUpdate?.({
				content: [
					{
						type: "text",
						text: reusedContext
							? `Delegating to ${formatModelSpec(spec)} (warm context)...`
							: `Starting sidekick ${formatModelSpec(spec)} (${config.toolMode})...`,
					},
				],
				details: skipDetails(params, reusedContext),
			});

			if (!handle) {
				handle = await createSidekickSession({ cwd: ctx.cwd, config, spec, model });
			}

			const before = handle.session.getSessionStats();
			const startedAt = Date.now();
			let outcome;
			startLiveIndicator(ctx, spec);
			try {
				outcome = await runDelegation(handle, buildDelegationPrompt(params, config.maxTaskChars), {
					signal,
					timeoutMs: config.timeoutMs,
				});
			} finally {
				stopLiveIndicator(ctx);
			}
			const elapsedMs = Date.now() - startedAt;
			const after = handle.session.getSessionStats();

			const tokens = diffTokens(after.tokens, before.tokens);
			const cost = Math.max(0, after.cost - before.cost);
			const counterfactual = counterfactualCost(comparisonModel(ctx), tokens) ?? 0;

			stats.delegations += 1;
			stats.tokens = addTokens(stats.tokens, tokens);
			stats.sidekickCost += cost;
			stats.counterfactualCost += counterfactual;
			if (outcome.ok) {
				stats.consecutiveFailures = 0;
				stats.cleanDelegations += 1;
			} else {
				stats.failures += 1;
				stats.consecutiveFailures += 1;
				stats.cleanDelegations = 0;
			}
			persistState(pi, config, stats);
			updateStatus(ctx);

			const details: DelegateToolDetails = {
				fusion: {
					sidekick: formatModelSpec(spec),
					toolMode: config.toolMode,
					delegations: stats.delegations,
					maxDelegations: config.maxDelegations,
					elapsedMs,
					ok: outcome.ok,
					tokens,
					cost,
					counterfactual,
					reusedContext,
				},
				state: makeStateEntry(config, stats),
			};

			if (!outcome.ok) {
				const partial = outcome.text ? `\n\nPartial output:\n${outcome.text}` : "";
				return {
					content: [
						{
							type: "text" as const,
							text: `Delegation failed on ${formatModelSpec(spec)}: ${outcome.errorMessage}. Do this task yourself.${partial}`,
						},
					],
					details,
				};
			}

			const footer = `[sidekick ${formatModelSpec(spec)} · ${config.toolMode} · ${formatTokens(tokens.total)} tok · ${formatUsd(cost)}${counterfactual > cost ? ` vs ${formatUsd(counterfactual)} on main` : ""} · ${stats.delegations}/${config.maxDelegations}]`;
			return {
				content: [
					{
						type: "text" as const,
						text: `${outcome.text}\n\n${footer}`,
					},
				],
				details,
			};
		},
	});

	pi.registerCommand("fusion", {
		description:
			"Configure pi-fusion: status, enable, disable, sidekick, upgrade, frontier, tools, thinking, max-delegations, routing, restart, reset",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			// Bare `/fusion` opens the panel when there is a terminal to draw it on;
			// `/fusion status` and every subcommand stay text, so scripts and print
			// mode are unaffected.
			if (!trimmed && ctx.hasUI) {
				await openConfigPanel(ctx);
				return;
			}
			const result = handleCommand(trimmed, ctx);
			if (result.persist) persistState(pi, config, stats);
			if (result.syncTool) syncActiveTool(pi);
			if (result.dropSidekick) dropSidekick();
			updateStatus(ctx);
			ctx.ui.notify(result.message, result.level);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		refreshStateFromBranch(ctx);
		captureBaseline(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		refreshStateFromBranch(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		if (!config.enabled) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${buildMainAgentGuidance(config, stats)}` };
	});

	pi.on("turn_start", async () => {
		persistState(pi, config, stats);
	});

	// Model switches ride along with compaction: the cache miss is already paid,
	// so changing the model here costs nothing extra.
	pi.on("session_compact", async (_event, ctx) => {
		if (!config.enabled || !config.routing) return;
		const decision = decideRoute({
			delegations: stats.delegations,
			consecutiveFailures: stats.consecutiveFailures,
			cleanDelegations: stats.cleanDelegations,
			sidekickUpgraded: stats.sidekickUpgraded,
			mainEscalated: stats.mainEscalated,
			hasUpgrade: config.sidekickUpgrade !== undefined,
			hasFrontier: config.frontier !== undefined,
		});
		await applyRoute(decision, ctx);
	});

	pi.on("session_shutdown", async () => {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		dropSidekick();
	});

	pi.on("model_select", async (event, ctx) => {
		liveMainModel = { provider: event.model.provider, modelId: event.model.id };
		updateStatus(ctx);
	});

	async function openConfigPanel(ctx: ExtensionContext): Promise<void> {
		for (;;) {
			const rows = buildMenuRows(config, stats);
			const choice = await ctx.ui.select("pi-fusion", rows.map((row) => row.label));
			const row = rowForLabel(rows, choice);
			// Escape returns undefined, which closes the panel.
			if (!row || row.key === "close") return;
			const done = await applyMenuChoice(row.key, ctx);
			if (done) return;
		}
	}

	async function applyMenuChoice(key: MenuKey, ctx: ExtensionContext): Promise<boolean> {
		switch (key) {
			case "sidekick":
			case "upgrade":
			case "frontier": {
				await pickModelInto(key, ctx);
				return false;
			}
			case "tools": {
				const mode = await ctx.ui.select("Sidekick tools", ["readonly", "coding"]);
				if (!mode || !parseToolMode(mode)) return false;
				if (mode === "coding") {
					const ok = await ctx.ui.confirm(
						"Give the sidekick write access?",
						"The sidekick runs without approval prompts: in coding mode it edits files and runs bash unattended.",
					);
					if (!ok) return false;
				}
				config.toolMode = mode as typeof config.toolMode;
				commit(ctx, `Sidekick tools: ${toolsForMode(config.toolMode).join(", ")}`, true);
				return false;
			}
			case "thinking": {
				const level = await ctx.ui.select("Sidekick thinking", [
					"off",
					"minimal",
					"low",
					"medium",
					"high",
					"xhigh",
					"max",
				]);
				const parsed = parseThinkingLevel(level);
				if (!parsed) return false;
				config.thinkingLevel = parsed;
				commit(ctx, `Sidekick thinking: ${parsed}`, true);
				return false;
			}
			case "max-delegations": {
				const value = await ctx.ui.input("Max delegations per branch", String(config.maxDelegations));
				const parsed = value === undefined ? undefined : parsePositiveInt(value);
				if (parsed === undefined) {
					if (value !== undefined) ctx.ui.notify("Enter a positive whole number", "error");
					return false;
				}
				config.maxDelegations = parsed;
				commit(ctx, `Max delegations: ${parsed}`);
				return false;
			}
			case "routing": {
				config.routing = !config.routing;
				if (config.routing) captureBaseline(ctx);
				const missing = config.routing && !config.frontier && !config.sidekickUpgrade;
				commit(ctx, `Compaction routing ${config.routing ? "on" : "off"}`);
				if (missing) {
					ctx.ui.notify("Routing has nothing to route to yet: set a stronger sidekick or a frontier model.", "warning");
				}
				return false;
			}
			case "enabled": {
				config.enabled = !config.enabled;
				syncActiveTool(pi);
				if (!config.enabled) dropSidekick();
				commit(ctx, `pi-fusion ${config.enabled ? "enabled" : "disabled"}`);
				return false;
			}
			case "restart": {
				dropSidekick();
				ctx.ui.notify("Sidekick context cleared; the next delegation starts a fresh one", "info");
				return false;
			}
			case "reset": {
				const ok = await ctx.ui.confirm("Reset counters?", "Clears delegation counts, savings, and the sidekick's context.");
				if (!ok) return false;
				stats = defaultStats();
				dropSidekick();
				commit(ctx, "Counters reset");
				return false;
			}
			default:
				return true;
		}
	}

	async function pickModelInto(slot: "sidekick" | "upgrade" | "frontier", ctx: ExtensionContext): Promise<void> {
		const spec = await pickModel(ctx, slot === "frontier" ? "priciest" : "cheapest", slot !== "sidekick");
		if (spec === undefined) return;
		if (spec === null) {
			if (slot === "upgrade") {
				config.sidekickUpgrade = undefined;
				stats.sidekickUpgraded = false;
			} else if (slot === "frontier") {
				config.frontier = undefined;
			}
			commit(ctx, `${slot} cleared`, slot === "upgrade");
			return;
		}
		if (slot === "sidekick") config.sidekick = spec;
		else if (slot === "upgrade") config.sidekickUpgrade = spec;
		else config.frontier = spec;
		commit(ctx, `${slot}: ${formatModelSpec(spec)}`, slot !== "frontier");
	}

	/** undefined = cancelled, null = cleared, otherwise the chosen model. */
	async function pickModel(
		ctx: ExtensionContext,
		order: ModelOrder,
		allowClear: boolean,
	): Promise<ModelSpec | null | undefined> {
		const models = safeAvailableModels(ctx);
		const providerRows = buildProviderRows(models);
		const extras = [MANUAL_ENTRY_LABEL, ...(allowClear ? [CLEAR_LABEL] : [])];
		const providerChoice = await ctx.ui.select("Provider", [...extras, ...providerRows.map((row) => row.label)]);
		if (providerChoice === undefined) return undefined;
		if (providerChoice === CLEAR_LABEL) return null;
		if (providerChoice === MANUAL_ENTRY_LABEL) return await promptForModel(ctx);

		const provider = rowForLabel(providerRows, providerChoice)?.key;
		if (!provider) return undefined;
		const modelRows = buildModelRows(models, provider, order);
		if (modelRows.length === 0) return await promptForModel(ctx);
		const modelChoice = await ctx.ui.select(`${provider} models`, [MANUAL_ENTRY_LABEL, ...modelRows.map((row) => row.label)]);
		if (modelChoice === undefined) return undefined;
		if (modelChoice === MANUAL_ENTRY_LABEL) return await promptForModel(ctx);
		const chosen = rowForLabel(modelRows, modelChoice)?.key;
		return chosen ? parseModelSpec(chosen) : undefined;
	}

	async function promptForModel(ctx: ExtensionContext): Promise<ModelSpec | undefined> {
		const typed = await ctx.ui.input("Model", "provider/model");
		if (!typed) return undefined;
		const spec = parseModelSpec(typed);
		if (!spec) {
			ctx.ui.notify("Expected provider/model, for example openai-codex/gpt-5.6-luna", "error");
			return undefined;
		}
		if (!ctx.modelRegistry.find(spec.provider, spec.modelId)) {
			ctx.ui.notify(`Model not found: ${formatModelSpec(spec)}`, "error");
			return undefined;
		}
		return spec;
	}

	function safeAvailableModels(ctx: ExtensionContext) {
		try {
			return ctx.modelRegistry.getAvailable();
		} catch {
			return [];
		}
	}

	/** Every panel edit persists immediately: there is no separate save step. */
	function commit(ctx: ExtensionContext, message: string, resetSidekick = false): void {
		if (resetSidekick) dropSidekick();
		persistState(pi, config, stats);
		updateStatus(ctx);
		ctx.ui.notify(message, "info");
	}

	function activeSidekickSpec(): ModelSpec {
		return stats.sidekickUpgraded && config.sidekickUpgrade ? config.sidekickUpgrade : config.sidekick;
	}

	/**
	 * While a delegation runs, the footer and the working row name the model that
	 * is actually executing - otherwise the only model on screen is the main one,
	 * which is precisely the model that is idle.
	 */
	function startLiveIndicator(ctx: ExtensionContext, spec: ModelSpec): void {
		activeDelegation = { spec, startedAt: Date.now() };
		refreshLiveIndicator(ctx);
		ticker = setInterval(() => refreshLiveIndicator(ctx), 1000);
		ticker.unref?.();
	}

	function stopLiveIndicator(ctx: ExtensionContext): void {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		activeDelegation = undefined;
		// showIdle restores the default working row even when the status is cleared,
		// so disabling mid-delegation cannot leave a stale "sidekick running" row.
		updateStatus(ctx);
	}

	function refreshLiveIndicator(ctx: ExtensionContext): void {
		if (!ctx.hasUI || !activeDelegation) return;
		showRunning(ctx.ui, {
			spec: activeDelegation.spec,
			delegationIndex: stats.delegations + 1,
			maxDelegations: config.maxDelegations,
			elapsedMs: Date.now() - activeDelegation.startedAt,
		});
	}

	function dropSidekick(): void {
		// Runs from session_shutdown too, where the surrounding runtime may already
		// be half torn down. A failed dispose must not take the session's exit with it.
		try {
			handle?.session.dispose();
		} catch {
			// Nothing left to clean up.
		}
		handle = undefined;
	}

	function captureBaseline(ctx: ExtensionContext): void {
		if (!ctx.model) return;
		baselineModel = { provider: ctx.model.provider, modelId: ctx.model.id };
		liveMainModel ??= baselineModel;
	}

	/**
	 * Savings are always quoted against the model the session started on. Using the
	 * live model instead would inflate the number the moment routing escalates the
	 * main agent, which is the opposite of what the figure is for.
	 */
	function comparisonModel(ctx: ExtensionContext): unknown {
		if (baselineModel) {
			const model = ctx.modelRegistry.find(baselineModel.provider, baselineModel.modelId);
			if (model) return model;
		}
		return ctx.model;
	}

	async function applyRoute(decision: RouteDecision, ctx: ExtensionContext): Promise<void> {
		if (decision.action === "hold") return;

		if (decision.action === "upgrade_sidekick") {
			stats.sidekickUpgraded = true;
			stats.consecutiveFailures = 0;
			dropSidekick();
			notifyRoute(ctx, `fusion: sidekick upgraded to ${formatModelSpec(config.sidekickUpgrade)} — ${decision.reason}`);
		} else if (decision.action === "escalate_main" && config.frontier) {
			captureBaselineIfUnset(ctx);
			const applied = await setMainModel(config.frontier, ctx);
			if (!applied) return;
			stats.mainEscalated = true;
			stats.consecutiveFailures = 0;
			stats.cleanDelegations = 0;
			notifyRoute(ctx, `fusion: main agent escalated to ${formatModelSpec(config.frontier)} — ${decision.reason}`);
		} else if (decision.action === "downgrade_main" && baselineModel) {
			const applied = await setMainModel(baselineModel, ctx);
			if (!applied) return;
			stats.mainEscalated = false;
			stats.cleanDelegations = 0;
			notifyRoute(ctx, `fusion: main agent returned to ${formatModelSpec(baselineModel)} — ${decision.reason}`);
		} else {
			return;
		}

		persistState(pi, config, stats);
		updateStatus(ctx);
	}

	function captureBaselineIfUnset(ctx: ExtensionContext): void {
		if (!baselineModel) captureBaseline(ctx);
	}

	async function setMainModel(spec: ModelSpec, ctx: ExtensionContext): Promise<boolean> {
		const model = ctx.modelRegistry.find(spec.provider, spec.modelId);
		if (!model) {
			notifyRoute(ctx, `fusion: cannot route to ${formatModelSpec(spec)} (model not found)`, "warning");
			return false;
		}
		const ok = await pi.setModel(model);
		if (!ok) notifyRoute(ctx, `fusion: no API key for ${formatModelSpec(spec)}`, "warning");
		return ok;
	}

	function notifyRoute(ctx: ExtensionContext, message: string, level: "info" | "warning" = "info"): void {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	}

	function refreshStateFromBranch(ctx: ExtensionContext): void {
		config = defaultConfig();
		stats = defaultStats();
		const restored = restoreStateFromSession(ctx);
		if (!restored) applyStartupFlags(pi);
		ensureSidekickResolves(ctx);
		syncActiveTool(pi);
		updateStatus(ctx);
	}

	function restoreStateFromSession(ctx: ExtensionContext): boolean {
		let restored = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
				restored = true;
				applyStateEntry(entry.data as Partial<FusionStateEntry> | undefined);
			}
			if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === TOOL_NAME) {
				restored = true;
				const details = entry.message.details as Partial<DelegateToolDetails> | undefined;
				applyStateEntry(details?.state);
			}
		}
		return restored;
	}

	function applyStateEntry(data: Partial<FusionStateEntry> | undefined): void {
		if (!data) return;
		if (data.config) config = normalizeConfig(data.config, config);
		if (data.stats) stats = normalizeStats(data.stats, stats);
	}

	function applyStartupFlags(api: ExtensionAPI): void {
		const enabled = api.getFlag("fusion-enabled");
		if (typeof enabled === "boolean") config.enabled = enabled;

		const routing = api.getFlag("fusion-routing");
		if (typeof routing === "boolean") config.routing = routing;

		const sidekick = stringFlag(api, "fusion-sidekick");
		if (sidekick) {
			const parsed = parseModelSpec(sidekick);
			if (parsed) config.sidekick = parsed;
		}

		const upgrade = stringFlag(api, "fusion-sidekick-upgrade");
		if (upgrade) config.sidekickUpgrade = parseModelSpec(upgrade) ?? config.sidekickUpgrade;

		const frontier = stringFlag(api, "fusion-frontier");
		if (frontier) config.frontier = parseModelSpec(frontier) ?? config.frontier;

		const toolMode = parseToolMode(stringFlag(api, "fusion-tools"));
		if (toolMode) config.toolMode = toolMode;

		const thinking = parseThinkingLevel(stringFlag(api, "fusion-thinking"));
		if (thinking) config.thinkingLevel = thinking;

		const maxDelegations = stringFlag(api, "fusion-max-delegations");
		if (maxDelegations) {
			const parsed = parsePositiveInt(maxDelegations);
			if (parsed !== undefined) config.maxDelegations = parsed;
		}
	}

	function ensureSidekickResolves(ctx: ExtensionContext): void {
		const registry = ctx.modelRegistry;
		if (modelResolves(registry, config.sidekick)) return;
		const previous = formatModelSpec(config.sidekick);
		const working = resolveSidekickModel(registry);
		if (!working) return;
		config.sidekick = working;
		dropSidekick();
		persistState(pi, config, stats);
		if (ctx.hasUI) {
			ctx.ui.notify(`Sidekick model ${previous} not found. Falling back to ${formatModelSpec(working)}.`, "warning");
		}
	}

	function handleCommand(
		args: string,
		ctx: ExtensionContext,
	): {
		message: string;
		level: "info" | "warning" | "error";
		persist: boolean;
		syncTool: boolean;
		dropSidekick: boolean;
	} {
		if (!args || args === "status") {
			return { message: formatStatus(ctx), level: "info", persist: false, syncTool: false, dropSidekick: false };
		}

		const [command, ...rest] = args.split(/\s+/);
		const value = rest.join(" ").trim();

		switch (command) {
			case "enable":
				config.enabled = true;
				return { message: "pi-fusion enabled", level: "info", persist: true, syncTool: true, dropSidekick: false };
			case "disable":
				config.enabled = false;
				if (ticker) clearInterval(ticker);
				ticker = undefined;
				activeDelegation = undefined;
				return { message: "pi-fusion disabled", level: "info", persist: true, syncTool: true, dropSidekick: true };
			case "restart":
				return {
					message: "Sidekick context cleared; the next delegation starts a fresh one",
					level: "info",
					persist: false,
					syncTool: false,
					dropSidekick: true,
				};
			case "reset":
				stats = defaultStats();
				return { message: "pi-fusion counters reset", level: "info", persist: true, syncTool: false, dropSidekick: true };
			case "sidekick":
				return setModelOption(ctx, value, "sidekick");
			case "upgrade":
				return setModelOption(ctx, value, "upgrade");
			case "frontier":
				return setModelOption(ctx, value, "frontier");
			case "tools": {
				const mode = parseToolMode(value);
				if (!mode) {
					return usage("Usage: /fusion tools <readonly|coding>");
				}
				config.toolMode = mode;
				const note =
					mode === "coding"
						? "Sidekick can now edit, write, and run bash. It has no approval prompts of its own — every action runs unattended."
						: "Sidekick is read-only.";
				return {
					message: `pi-fusion sidekick tools: ${toolsForMode(mode).join(", ")}. ${note}`,
					level: mode === "coding" ? "warning" : "info",
					persist: true,
					syncTool: false,
					dropSidekick: true,
				};
			}
			case "thinking": {
				const level = parseThinkingLevel(value);
				if (!level) return usage("Usage: /fusion thinking <off|minimal|low|medium|high|xhigh>");
				config.thinkingLevel = level;
				return {
					message: `pi-fusion sidekick thinking: ${level}`,
					level: "info",
					persist: true,
					syncTool: false,
					dropSidekick: true,
				};
			}
			case "max-delegations": {
				const parsed = parsePositiveInt(value);
				if (parsed === undefined) return usage("Usage: /fusion max-delegations <positive-number>");
				config.maxDelegations = parsed;
				return {
					message: `pi-fusion max delegations: ${parsed}`,
					level: "info",
					persist: true,
					syncTool: false,
					dropSidekick: false,
				};
			}
			case "routing": {
				const parsed = parseBoolean(value);
				if (parsed === undefined) return usage("Usage: /fusion routing <on|off>");
				config.routing = parsed;
				if (parsed) captureBaseline(ctx);
				const missing = parsed && !config.frontier && !config.sidekickUpgrade;
				return {
					message: missing
						? "pi-fusion routing on, but nothing to route to. Set /fusion frontier <provider>/<model> or /fusion upgrade <provider>/<model>."
						: `pi-fusion routing ${parsed ? "on" : "off"}`,
					level: missing ? "warning" : "info",
					persist: true,
					syncTool: false,
					dropSidekick: false,
				};
			}
			default:
				return usage(
					"Usage: /fusion [status|enable|disable|sidekick <provider>/<model>|upgrade <provider>/<model>|none|frontier <provider>/<model>|none|tools <readonly|coding>|thinking <level>|max-delegations <n>|routing <on|off>|restart|reset]",
				);
		}
	}

	function setModelOption(ctx: ExtensionContext, value: string, slot: "sidekick" | "upgrade" | "frontier") {
		if (slot !== "sidekick" && (value === "none" || value === "off")) {
			if (slot === "upgrade") {
				config.sidekickUpgrade = undefined;
				stats.sidekickUpgraded = false;
			} else {
				config.frontier = undefined;
			}
			return {
				message: `pi-fusion ${slot} cleared`,
				level: "info" as const,
				persist: true,
				syncTool: false,
				dropSidekick: slot === "upgrade",
			};
		}

		const parsed = parseModelSpec(value);
		if (!parsed) return usage(`Usage: /fusion ${slot} <provider>/<model>`);
		if (!ctx.modelRegistry.find(parsed.provider, parsed.modelId)) {
			return {
				message: `Model not found: ${formatModelSpec(parsed)}`,
				level: "error" as const,
				persist: false,
				syncTool: false,
				dropSidekick: false,
			};
		}

		if (slot === "sidekick") config.sidekick = parsed;
		else if (slot === "upgrade") config.sidekickUpgrade = parsed;
		else config.frontier = parsed;

		return {
			message: `pi-fusion ${slot} model: ${formatModelSpec(parsed)}`,
			level: "info" as const,
			persist: true,
			syncTool: false,
			dropSidekick: slot !== "frontier",
		};
	}

	function syncActiveTool(api: ExtensionAPI): void {
		const active = api.getActiveTools();
		const present = active.includes(TOOL_NAME);
		if (config.enabled && !present) api.setActiveTools([...active, TOOL_NAME]);
		else if (!config.enabled && present) api.setActiveTools(active.filter((tool) => tool !== TOOL_NAME));
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		// A disabled extension clears both slots, even if a delegation is still
		// winding down: the ticker is stopped before this runs.
		if (!config.enabled) {
			showIdle(ctx.ui, undefined);
			return;
		}
		if (activeDelegation) {
			refreshLiveIndicator(ctx);
			return;
		}
		showIdle(ctx.ui, idleState());
	}

	function idleState(): IdleState {
		return {
			sidekick: activeSidekickSpec(),
			delegations: stats.delegations,
			maxDelegations: config.maxDelegations,
			saved: stats.counterfactualCost - stats.sidekickCost,
			escalatedMain: stats.mainEscalated && liveMainModel ? liveMainModel : undefined,
			struggling: stats.consecutiveFailures > 0,
		};
	}

	function formatStatus(ctx: ExtensionContext): string {
		const spec = activeSidekickSpec();
		const found = ctx.modelRegistry.find(spec.provider, spec.modelId) ? "available" : "not found";
		const mainNow = liveMainModel ?? (ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined);
		return [
			`pi-fusion ${config.enabled ? "enabled" : "disabled"}`,
			`running now: ${activeDelegation ? `sidekick ${formatModelSpec(activeDelegation.spec)}` : `main agent ${formatModelSpec(mainNow)}`}`,
			`main: ${formatModelSpec(mainNow)}${stats.mainEscalated ? ` [escalated from ${formatModelSpec(baselineModel)}]` : ""}`,
			`sidekick: ${formatModelSpec(spec)} (${found})${stats.sidekickUpgraded ? " [upgraded]" : ""}`,
			`tools: ${config.toolMode} (${toolsForMode(config.toolMode).join(", ")})`,
			`thinking: ${config.thinkingLevel}`,
			`context: ${handle ? "warm" : "cold"}`,
			`delegations: ${stats.delegations}/${config.maxDelegations} (${stats.failures} failed)`,
			`routing: ${config.routing ? "on" : "off"} • upgrade: ${formatModelSpec(config.sidekickUpgrade)} • frontier: ${formatModelSpec(config.frontier)}${stats.mainEscalated ? " [escalated]" : ""}`,
			formatSavings(stats),
		].join("\n");
	}

	function skipResult(text: string, params: DelegateToolInput, reusedContext: boolean) {
		return {
			content: [{ type: "text" as const, text }],
			details: skipDetails(params, reusedContext),
		};
	}

	function skipDetails(params: DelegateToolInput, reusedContext: boolean): DelegateToolDetails {
		return {
			fusion: {
				sidekick: formatModelSpec(activeSidekickSpec()),
				toolMode: config.toolMode,
				delegations: stats.delegations,
				maxDelegations: config.maxDelegations,
				elapsedMs: 0,
				ok: false,
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: 0,
				counterfactual: 0,
				reusedContext,
			},
			state: makeStateEntry(config, stats),
		};
	}
}

function usage(message: string) {
	return { message, level: "error" as const, persist: false, syncTool: false, dropSidekick: false };
}

function stringFlag(api: ExtensionAPI, name: string): string | undefined {
	const value = api.getFlag(name);
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Re-sent on every turn, so it carries only what changes behaviour. The two
 * middle sentences are the ones the benchmark's judgment task depends on; the
 * model inventory and delegation count that used to be here did not earn their
 * tokens.
 */
export function buildMainAgentGuidance(config: FusionConfig, _stats: FusionStats): string {
	const lines = [
		"You are the main agent in a two-agent harness. `delegate` hands work to a cheaper sidekick with its own tools and context; it cannot see this conversation, so put what it needs in `context`.",
		"Take minimal actions yourself. Default to delegating and monitoring, and keep the decisions that matter: the plan, the interpretation of ambiguity, and the final review.",
		"When the deliverable is the judgment itself, do the work yourself.",
		"Delegate by how much output the work produces, not how many steps it takes: one command printing hundreds of lines belongs with the sidekick; a lookup answered in a line or two does not.",
	];
	if (config.toolMode === "readonly") {
		lines.push("The sidekick is read-only: it investigates and verifies, you apply every change.");
	}
	return lines.join("\n");
}

export function makeStateEntry(config: FusionConfig, stats: FusionStats): FusionStateEntry {
	return { version: 1, config: { ...config }, stats: { ...stats, tokens: { ...stats.tokens } }, updatedAt: new Date().toISOString() };
}

export function persistState(pi: ExtensionAPI, config: FusionConfig, stats: FusionStats): void {
	pi.appendEntry(STATE_ENTRY, makeStateEntry(config, stats));
}

export { shortModelName } from "./indicator.js";
