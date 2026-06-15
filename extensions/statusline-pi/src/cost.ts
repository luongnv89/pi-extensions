import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface TokenUsageCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface AssistantUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost?: TokenUsageCost;
}

interface ModelRates {
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

interface AssistantBranchMessage {
	role: "assistant";
	usage: AssistantUsage;
}

export interface SessionCostState {
	totalUsd: number;
	lastTurnUsd?: number;
	hasPricedTurn: boolean;
	hasUnknownPricing: boolean;
	hasUnpricedUsage: boolean;
}

export function createEmptySessionCostState(): SessionCostState {
	return {
		totalUsd: 0,
		hasPricedTurn: false,
		hasUnknownPricing: false,
		hasUnpricedUsage: false,
	};
}

/** Per-million token rates (same formula as Pi's calculateCost). */
export function calculateCostFromModelRates(model: ModelRates, usage: AssistantUsage): number {
	const { input, output, cacheRead, cacheWrite } = model.cost;
	const inputUsd = (input / 1_000_000) * usage.input;
	const outputUsd = (output / 1_000_000) * usage.output;
	const cacheReadUsd = (cacheRead / 1_000_000) * usage.cacheRead;
	const cacheWriteUsd = (cacheWrite / 1_000_000) * usage.cacheWrite;
	return inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd;
}

export function modelRegistryHasPricing(model: ModelRates | undefined): boolean {
	if (!model) return false;
	const { input, output, cacheRead, cacheWrite } = model.cost;
	return input > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0;
}

export function resolveTurnUsd(usage: AssistantUsage, model?: ModelRates): number {
	const reported = usage.cost?.total ?? 0;
	if (reported > 0) return reported;
	if (model && modelRegistryHasPricing(model)) {
		return calculateCostFromModelRates(model, usage);
	}
	return 0;
}

export function addAssistantMessageCost(
	state: SessionCostState,
	usage: AssistantUsage | undefined,
	model?: ModelRates,
): SessionCostState {
	if (!usage) {
		return { ...state, hasUnknownPricing: true };
	}

	const turnUsd = resolveTurnUsd(usage, model);
	const pricedTurn = turnUsd > 0 || modelHasNonZeroRates(usage);
	const tokens = hasTokenUsage(usage);
	const activeModelUnpriced = model !== undefined && !modelRegistryHasPricing(model);

	return {
		totalUsd: state.totalUsd + Math.max(0, turnUsd),
		lastTurnUsd: turnUsd,
		hasPricedTurn: state.hasPricedTurn || pricedTurn,
		hasUnpricedUsage: state.hasUnpricedUsage || (tokens && activeModelUnpriced),
		hasUnknownPricing:
			state.hasUnknownPricing ||
			(tokens && !pricedTurn && !activeModelUnpriced && (model === undefined || modelRegistryHasPricing(model))),
	};
}

export function aggregateSessionCostFromContext(ctx: ExtensionContext): SessionCostState {
	let state = createEmptySessionCostState();
	const branch = ctx.sessionManager.getBranch();
	const model = ctx.model;

	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		state = addAssistantMessageCost(state, (message as AssistantBranchMessage).usage, model);
	}

	return state;
}

export function modelHasNonZeroRates(usage: AssistantUsage): boolean {
	const cost = usage.cost;
	if (!cost) return false;
	return cost.input > 0 || cost.output > 0 || cost.cacheRead > 0 || cost.cacheWrite > 0;
}

export function hasTokenUsage(usage: AssistantUsage): boolean {
	return usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0;
}

export function modelRegistryHasPricingFromContext(ctx: ExtensionContext): boolean {
	return modelRegistryHasPricing(ctx.model);
}

export type CostDisplayKind = "amount" | "zero" | "unknown" | "unpriced";

export function getCostDisplayKind(state: SessionCostState, ctx: ExtensionContext): CostDisplayKind {
	if (state.hasPricedTurn || state.totalUsd > 0) return "amount";
	if (state.hasUnpricedUsage || (ctx.model && !modelRegistryHasPricingFromContext(ctx))) return "unpriced";
	if (state.hasUnknownPricing) return "unknown";
	if (state.totalUsd === 0 && !state.hasUnknownPricing) return "zero";
	return "unknown";
}

export function formatCostUsd(amount: number): string {
	if (!Number.isFinite(amount) || amount <= 0) return "$0.00";
	if (amount < 0.01) return `$${amount.toFixed(4)}`;
	if (amount < 1) return `$${amount.toFixed(3)}`;
	if (amount < 100) return `$${amount.toFixed(2)}`;
	return `$${amount.toFixed(2)}`;
}

export function formatCostSection(
	theme: ExtensionContext["ui"]["theme"],
	state: SessionCostState,
	ctx: ExtensionContext,
): string {
	const kind = getCostDisplayKind(state, ctx);

	switch (kind) {
		case "amount":
			return theme.fg("warning", formatCostUsd(state.totalUsd));
		case "zero":
			return theme.fg("dim", "$0.00");
		case "unpriced":
			return "";
		default:
			return theme.fg("warning", "cost ?");
	}
}