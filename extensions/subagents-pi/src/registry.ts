/** Cross-package registry published by @tintinweb/pi-subagents. */
const MANAGER_KEY = Symbol.for("pi-subagents:manager");

export type AgentStatus =
	| "queued"
	| "running"
	| "completed"
	| "steered"
	| "aborted"
	| "stopped"
	| "error";

export interface AgentInvocationSnapshot {
	modelName?: string;
	thinking?: string;
}

export interface AgentRecordSnapshot {
	id: string;
	type: string;
	description: string;
	status: AgentStatus;
	toolUses: number;
	startedAt: number;
	completedAt?: number;
	lifetimeUsage: { input: number; output: number; cacheWrite: number };
	compactionCount: number;
	invocation?: AgentInvocationSnapshot;
	session?: {
		model?: { provider: string; id: string };
		thinkingLevel?: string;
		getSessionStats(): {
			tokens: {
				input: number;
				output: number;
				cacheRead?: number;
				cacheWrite: number;
				total?: number;
			};
			contextUsage?: {
				tokens: number | null;
				contextWindow: number;
				percent: number | null;
			};
		};
	};
}

export interface SubagentsRegistry {
	getRecord: (id: string) => AgentRecordSnapshot | undefined;
	hasRunning: () => boolean;
}

export function getSubagentsRegistry(): SubagentsRegistry | undefined {
	const entry = (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
	if (!entry || typeof entry !== "object") return undefined;
	const registry = entry as Partial<SubagentsRegistry>;
	if (typeof registry.getRecord !== "function") return undefined;
	return registry as SubagentsRegistry;
}

export function isCompanionLoaded(): boolean {
	return getSubagentsRegistry() !== undefined;
}