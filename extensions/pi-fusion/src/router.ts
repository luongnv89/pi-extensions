/**
 * Compaction-boundary routing decisions.
 *
 * Pure heuristics on purpose: spending a model call to decide how to save model
 * calls defeats the point, and a pure function stays testable.
 */

export type RouteSignals = {
	/** Delegations completed so far this branch. */
	delegations: number;
	/** Failed delegations since the last successful one. */
	consecutiveFailures: number;
	/** Successful delegations since the last failure. */
	cleanDelegations: number;
	/** Sidekick currently running on the upgrade model. */
	sidekickUpgraded: boolean;
	/** Main agent currently running on the frontier model. */
	mainEscalated: boolean;
	/** A stronger sidekick is configured. */
	hasUpgrade: boolean;
	/** A frontier escalation target is configured. */
	hasFrontier: boolean;
};

export type RouteAction = "hold" | "upgrade_sidekick" | "escalate_main" | "downgrade_main";

export type RouteDecision = {
	action: RouteAction;
	reason: string;
};

export const ROUTER_THRESHOLDS = {
	/** Consecutive sidekick failures that trigger a step up. */
	escalateFailures: 2,
	/** Clean delegations on the frontier model before stepping back down. */
	downgradeCleanDelegations: 3,
} as const;

/**
 * Steps up one rung at a time: stronger sidekick first, main agent only after
 * that is exhausted. Mirrors Fusion's "upgrade the sidekick without going back
 * to the main model".
 */
export function decideRoute(signals: RouteSignals): RouteDecision {
	const struggling = signals.consecutiveFailures >= ROUTER_THRESHOLDS.escalateFailures;

	if (struggling) {
		if (signals.hasUpgrade && !signals.sidekickUpgraded) {
			return {
				action: "upgrade_sidekick",
				reason: `${signals.consecutiveFailures} consecutive sidekick failures; upgrading the sidekick before touching the main agent`,
			};
		}
		if (signals.hasFrontier && !signals.mainEscalated) {
			return {
				action: "escalate_main",
				reason: `${signals.consecutiveFailures} consecutive sidekick failures with no sidekick headroom left; escalating the main agent`,
			};
		}
		return { action: "hold", reason: "struggling, but no escalation target is configured" };
	}

	if (
		signals.mainEscalated &&
		signals.consecutiveFailures === 0 &&
		signals.cleanDelegations >= ROUTER_THRESHOLDS.downgradeCleanDelegations
	) {
		return {
			action: "downgrade_main",
			reason: `${signals.cleanDelegations} clean delegations since escalating; returning the main agent to its baseline model`,
		};
	}

	return { action: "hold", reason: "no routing signal" };
}
