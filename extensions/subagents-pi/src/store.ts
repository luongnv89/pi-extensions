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

	/** Keep finished agents visible briefly, then drop from the fleet view. */
	pruneFinished(maxFinishedAgeMs = 30_000): void {
		const registry = getSubagentsRegistry();
		if (!registry) return;
		const now = Date.now();
		for (const id of [...this.trackedIds]) {
			const record = registry.getRecord(id);
			if (!record) {
				this.trackedIds.delete(id);
				continue;
			}
			if (record.status === "running" || record.status === "queued") continue;
			const completedAt = record.completedAt ?? now;
			if (now - completedAt > maxFinishedAgeMs) {
				this.trackedIds.delete(id);
			}
		}
	}

	listRows(): AgentMetricsRow[] {
		const registry = getSubagentsRegistry();
		if (!registry) return [];

		const rows: AgentMetricsRow[] = [];
		for (const id of this.trackedIds) {
			const record = registry.getRecord(id);
			if (!record) continue;
			try {
				rows.push(buildRow(record));
			} catch {
				this.trackedIds.delete(id);
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
	let totalTokens = getLifetimeTotal(usage);
	let contextPercent: number | null | undefined;
	try {
		const stats = record.session?.getSessionStats();
		const sessionTokens = getSessionTokenTotal(stats?.tokens);
		if (sessionTokens !== undefined) totalTokens = sessionTokens;
		contextPercent = stats?.contextUsage?.percent ?? null;
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