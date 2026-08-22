/** Short prompt-cache TTL (Anthropic default is 5 minutes). */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/** Anthropic long prompt-cache TTL when every cache-write token is billed at 1 hour. */
export const CACHE_TTL_LONG_MS = 60 * 60 * 1000;

/** Warn / warm when less than this time remains before the cache expires. */
export const CACHE_WARN_MS = 60 * 1000;

export interface CacheStatus {
	/** "idle": no cache activity yet; "active": counting down; "expired": TTL elapsed */
	state: "idle" | "active" | "expired";
	label: string;
	/** Milliseconds left before the cache expires (0 when expired/idle). */
	remainingMs: number;
}

/** Format a countdown as m:ss, clamped at 0:00. */
export function formatCountdown(ms: number): string {
	const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Compute the prompt-cache countdown state.
 *
 * The cache stays warm for the selected retention TTL after the last request
 * that read from or wrote to it; once the TTL elapses the next request is a miss.
 */
export function computeCacheStatus(
	lastActive: number | undefined,
	now: number,
	ttlMs: number = CACHE_TTL_MS,
): CacheStatus {
	if (lastActive === undefined) {
		return { state: "idle", label: "", remainingMs: 0 };
	}
	const remainingMs = Math.max(0, ttlMs - (now - lastActive));
	if (remainingMs <= 0) {
		return { state: "expired", label: "cache expired", remainingMs };
	}
	return { state: "active", label: `cache ${formatCountdown(remainingMs)}`, remainingMs };
}
