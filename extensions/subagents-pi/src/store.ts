import {
	computeOutputTps,
	formatContextLabel,
	formatDurationMs,
	formatModelLabel,
	formatThinkingLevel,
	formatTps,
	getLifetimeTotal,
	type LifetimeUsage,
} from "./format.js";
import { type AgentRecordSnapshot, getSubagentsRegistry } from "./registry.js";

/** Statuses that mean the agent is done and should leave the fleet panel. */
export const TERMINAL_STATUSES = new Set([
	"completed",
	"error",
	"aborted",
	"stopped",
]);

export function isActiveStatus(status: string): boolean {
	return !TERMINAL_STATUSES.has(status);
}

export interface AgentMetricsRow {
	id: string;
	type: string;
	description: string;
	status: string;
	model: string;
	thinking: string;
	context: string;
	tps: string;
	duration: string;
	toolUses: number;
}

export class SubagentMetricsStore {
	private readonly trackedIds = new Set<string>();
	private companionReady = false;

	markCompanionReady(): void {
		this.companionReady = true;
	}

	isCompanionReady(): boolean {
		return this.companionReady;
	}

	reset(): void {
		this.trackedIds.clear();
		this.companionReady = false;
	}

	trackId(id: string): void {
		if (id) this.trackedIds.add(id);
	}

	untrackId(id: string): void {
		this.trackedIds.delete(id);
	}

	/** Drop tracked IDs only after their companion registry records disappear. */
	pruneMissing(): void {
		const registry = getSubagentsRegistry();
		if (!registry) return;
		for (const id of this.trackedIds) {
			if (!registry.getRecord(id)) this.trackedIds.delete(id);
		}
	}

	/**
	 * Drop tracked IDs that finished (completed/error/aborted/stopped)
	 * so they leave the panel even while the companion still holds the record.
	 */
	pruneTerminal(): void {
		const registry = getSubagentsRegistry();
		if (!registry) return;
		for (const id of [...this.trackedIds]) {
			const record = registry.getRecord(id);
			if (!record || isActiveStatus(record.status)) continue;
			this.trackedIds.delete(id);
		}
	}

	listRows(): AgentMetricsRow[] {
		const registry = getSubagentsRegistry();
		if (!registry) return [];

		const rows: AgentMetricsRow[] = [];
		for (const id of this.trackedIds) {
			const record = registry.getRecord(id);
			if (!record) {
				this.trackedIds.delete(id);
				continue;
			}
			if (!isActiveStatus(record.status)) {
				this.trackedIds.delete(id);
				continue;
			}
			try {
				rows.push(buildRow(record));
			} catch {
				continue;
			}
		}

		rows.sort((a, b) => {
			const rank = (status: string) => (status === "running" ? 0 : status === "queued" ? 1 : 2);
			const diff = rank(a.status) - rank(b.status);
			if (diff !== 0) return diff;
			return a.description.localeCompare(b.description);
		});
		return rows;
	}

	visibleCount(): number {
		return this.listRows().length;
	}
}

function buildRow(record: AgentRecordSnapshot): AgentMetricsRow {
	const usage: LifetimeUsage = record.lifetimeUsage ?? { input: 0, output: 0, cacheWrite: 0 };
	let totalTokens: number | undefined = getLifetimeTotal(usage);
	let contextPercent: number | null | undefined;
	try {
		const stats = record.session?.getSessionStats();
		const contextUsage = stats?.contextUsage;
		if (contextUsage) {
			const contextTokens = contextUsage.tokens;
			totalTokens =
				typeof contextTokens === "number" && Number.isFinite(contextTokens) && contextTokens >= 0
					? contextTokens
					: undefined;
			contextPercent = contextUsage.percent;
		} else {
			const sessionTokens = getSessionTokenTotal(stats?.tokens);
			if (sessionTokens !== undefined) totalTokens = sessionTokens;
			contextPercent = null;
		}
	} catch {
		contextPercent = null;
	}

	const sessionModel = formatSessionModel(record.session?.model);
	const durationMs =
		record.status === "running" || record.status === "queued"
			? Math.max(0, Date.now() - record.startedAt)
			: Math.max(0, (record.completedAt ?? Date.now()) - record.startedAt);

	const tps =
		record.status === "queued" ? undefined : computeOutputTps(usage.output, durationMs);

	return {
		id: record.id,
		type: record.type,
		description: record.description,
		status: record.status,
		model: formatModelLabel(sessionModel ?? record.invocation?.modelName),
		thinking: formatThinkingLevel(record.session?.thinkingLevel ?? record.invocation?.thinking),
		context: formatContextLabel(totalTokens, contextPercent, record.compactionCount),
		tps: formatTps(tps),
		duration: formatDurationMs(durationMs),
		toolUses: record.toolUses,
	};
}

function formatSessionModel(model: { provider: string; id: string } | undefined): string | undefined {
	const provider = model?.provider?.trim();
	const id = model?.id?.trim();
	if (!provider || !id) return undefined;
	return `${provider}/${id}`;
}

function getSessionTokenTotal(
	tokens:
		| {
				input: number;
				output: number;
				cacheRead?: number;
				cacheWrite: number;
				total?: number;
		  }
		| undefined,
): number | undefined {
	if (!tokens) return undefined;
	if (Number.isFinite(tokens.total) && tokens.total! >= 0) return tokens.total;
	const total = tokens.input + tokens.output + (tokens.cacheRead ?? 0) + tokens.cacheWrite;
	return Number.isFinite(total) && total >= 0 ? total : undefined;
}
