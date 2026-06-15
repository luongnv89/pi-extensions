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

interface AssistantBranchMessage {
	role: "assistant";
	usage: AssistantUsage;
}

export interface SessionCostState {
	totalUsd: number;
	lastTurnUsd?: number;
	hasPricedTurn: boolean;
	hasUnknownPricing: boolean;
}

export function createEmptySessionCostState(): SessionCostState {
	return {
		totalUsd: 0,
		hasPricedTurn: false,
		hasUnknownPricing: false,
	};
}

export function addAssistantMessageCost(state: SessionCostState, usage: AssistantUsage | undefined): SessionCostState {
	if (!usage) {
		return { ...state, hasUnknownPricing: true };
	}

	const turnUsd = usage.cost?.total ?? 0;
	const rates = modelHasNonZeroRates(usage);
	const pricedTurn = turnUsd > 0 || rates;

	return {
		totalUsd: state.totalUsd + Math.max(0, turnUsd),
		lastTurnUsd: turnUsd,
		hasPricedTurn: state.hasPricedTurn || pricedTurn,
		hasUnknownPricing: state.hasUnknownPricing || (!pricedTurn && hasTokenUsage(usage)),
	};
}

export function aggregateSessionCostFromContext(ctx: ExtensionContext): SessionCostState {
	let state = createEmptySessionCostState();
	const branch = ctx.sessionManager.getBranch();

	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		state = addAssistantMessageCost(state, (message as AssistantBranchMessage).usage);
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

export function modelRegistryHasPricing(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	if (!model) return false;
	const { input, output, cacheRead, cacheWrite } = model.cost;
	return input > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0;
}

export type CostDisplayKind = "amount" | "zero" | "unknown" | "unpriced";

export function getCostDisplayKind(state: SessionCostState, ctx: ExtensionContext): CostDisplayKind {
	if (state.hasPricedTurn || state.totalUsd > 0) return "amount";
	if (state.hasUnknownPricing) return "unknown";
	if (ctx.model && !modelRegistryHasPricing(ctx)) return "unpriced";
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
			return theme.fg("dim", "cost n/a");
		default:
			return theme.fg("dim", "cost ?");
	}
}