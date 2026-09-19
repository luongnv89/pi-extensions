import type { Usage } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
	truncateTail,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import type { TokenTotals } from "./config.js";

/** The fixed marker is kept whole by reserving space for it before truncating. */
export const DELEGATE_TRUNCATION_NOTICE = "[truncated: full output is available in tool details]";

export type DelegateContent = {
	text: string;
	fullText: string;
	truncated: boolean;
	truncation?: TruncationResult;
};

/**
 * Keep the model-facing result within Pi's tool-result limits while retaining the
 * complete result for callers that inspect structured tool details.
 */
export function truncateDelegateContent(fullText: string): DelegateContent {
	const initial = truncateHead(fullText, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});
	if (!initial.truncated) {
		return { text: fullText, fullText, truncated: false };
	}

	const notice = `\n\n${DELEGATE_TRUNCATION_NOTICE}`;
	const noticeBytes = byteLength(notice);
	const noticeLines = notice.split("\n").length;
	const options = {
		maxBytes: Math.max(0, DEFAULT_MAX_BYTES - noticeBytes),
		maxLines: Math.max(0, DEFAULT_MAX_LINES - noticeLines),
	};

	// Head truncation keeps the sidekick's report opening. If one first line is
	// itself too large, tail truncation still preserves a useful ending and the
	// complete fixed notice remains inside both limits.
	let truncation = truncateHead(fullText, options);
	if (truncation.firstLineExceedsLimit) {
		truncation = truncateTail(fullText, options);
	}

	return {
		text: `${truncation.content}${notice}`,
		fullText,
		truncated: true,
		truncation,
	};
}

/** Convert one actual Pi usage value into the extension's persisted token shape. */
export function tokenTotalsFromUsage(usage: Usage): TokenTotals {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		total: usage.totalTokens,
	};
}

/**
 * Combine usage from assistant messages added during one delegation. A missing
 * usage value means no top-level usage should be fabricated for that turn.
 */
export function aggregateAssistantUsage(messages: readonly unknown[]): Usage | undefined {
	let combined: Usage | undefined;

	for (const message of messages) {
		if (!isRecord(message) || message.role !== "assistant" || !isUsage(message.usage)) continue;
		if (!combined) {
			combined = cloneUsage(message.usage);
			continue;
		}
		combined = addUsage(combined, message.usage);
	}

	return combined;
}

export type FailedDelegateDetails = {
	fusion: {
		ok: false;
	};
};

/** Only an explicitly typed `fusion.ok === false` marks a delegate failure. */
export function isFailedDelegateDetails(details: unknown): details is FailedDelegateDetails {
	if (!isRecord(details) || !isRecord(details.fusion)) return false;
	return details.fusion.ok === false;
}

function addUsage(a: Usage, b: Usage): Usage {
	const combined: Usage = {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		totalTokens: a.totalTokens + b.totalTokens,
		cost: {
			input: a.cost.input + b.cost.input,
			output: a.cost.output + b.cost.output,
			cacheRead: a.cost.cacheRead + b.cost.cacheRead,
			cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
			total: a.cost.total + b.cost.total,
		},
	};
	const cacheWrite1h = optionalSum(a.cacheWrite1h, b.cacheWrite1h);
	const reasoning = optionalSum(a.reasoning, b.reasoning);
	if (cacheWrite1h !== undefined) combined.cacheWrite1h = cacheWrite1h;
	if (reasoning !== undefined) combined.reasoning = reasoning;
	return combined;
}

function cloneUsage(usage: Usage): Usage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		...(usage.cacheWrite1h !== undefined ? { cacheWrite1h: usage.cacheWrite1h } : {}),
		...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
		totalTokens: usage.totalTokens,
		cost: { ...usage.cost },
	};
}

function optionalSum(a: number | undefined, b: number | undefined): number | undefined {
	if (a === undefined && b === undefined) return undefined;
	return (a ?? 0) + (b ?? 0);
}

function isUsage(value: unknown): value is Usage {
	if (!isRecord(value) || !isRecord(value.cost)) return false;
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
		if (!isFiniteNonNegative(value[key])) return false;
	}
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
		if (!isFiniteNonNegative(value.cost[key])) return false;
	}
	if (value.cacheWrite1h !== undefined && !isFiniteNonNegative(value.cacheWrite1h)) return false;
	if (value.reasoning !== undefined && !isFiniteNonNegative(value.reasoning)) return false;
	return true;
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}
