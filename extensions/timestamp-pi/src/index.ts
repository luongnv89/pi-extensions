import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** Custom entry type used for per-message timestamps (TUI-only, never sent to the LLM). */
export const ENTRY_TYPE = "timestamp-pi";

/** Prompt cache TTL (Anthropic default is 5 minutes). */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/** Warn when less than this time remains before the cache expires. */
export const CACHE_WARN_MS = 60 * 1000;

/**
 * Two entries for the same message within this window are treated as duplicates
 * (guards against the extension being loaded more than once).
 */
export const DUPLICATE_WINDOW_MS = 2_000;

export type TimestampKind = "user" | "assistant" | "tool";

export interface TimestampEntryData {
  role: "user" | "assistant";
  /** What the message was; older entries omit this and fall back to role. */
  kind?: TimestampKind;
  timestamp: number;
}

export interface CacheStatus {
  /** "idle": no cache activity yet; "active": counting down; "expired": TTL elapsed */
  state: "idle" | "active" | "expired";
  label: string;
  /** Milliseconds left before the cache expires (0 when expired/idle). */
  remainingMs: number;
}

/** Format an absolute time as HH:MM:SS (24h). */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Format a relative age: "now", "5s ago", "2m ago", "3h ago", "2d ago". */
export function formatRelative(ts: number, now: number): string {
  const diff = Math.max(0, Math.floor((now - ts) / 1000));
  if (diff < 5) return "now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** Format a countdown as m:ss, clamped at 0:00. */
export function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Human-readable label for a timestamp entry's kind. */
export function describeKind(kind: TimestampKind | undefined, role: TimestampEntryData["role"]): string {
  const resolved: TimestampKind = kind ?? (role === "user" ? "user" : "assistant");
  if (resolved === "tool") return "tool call";
  return resolved === "user" ? "user message" : "ai response";
}

/** Detect whether an assistant message ended with tool calls. */
export function isToolCallMessage(
  message: Pick<{ stopReason?: string; content?: Array<{ type?: string }> }, "stopReason" | "content">,
): boolean {
  return (
    message.stopReason === "toolUse" ||
    (Array.isArray(message.content) && message.content.some((block) => block?.type === "toolCall"))
  );
}

/** One-line timestamp marker rendered under a message. */
export function formatTimestampLine(data: TimestampEntryData, now: number): string {
  return `⏱ ${formatClock(data.timestamp)} (${formatRelative(data.timestamp, now)}) · ${describeKind(data.kind, data.role)}`;
}

/**
 * Check whether a timestamp entry for the same message already exists.
 *
 * Scans the tail of the session entries for an ENTRY_TYPE custom entry with the
 * same role and a timestamp within DUPLICATE_WINDOW_MS. This prevents duplicate
 * rendered lines when the extension is loaded more than once (e.g. installed
 * globally and also passed via -e).
 */
export function hasDuplicateTimestampEntry(
  entries: readonly unknown[],
  role: "user" | "assistant",
  timestamp: number,
): boolean {
  const lookBack = 10;
  for (let i = entries.length - 1; i >= 0 && i >= entries.length - lookBack; i--) {
    const entry = entries[i] as { type?: string; customType?: string; data?: TimestampEntryData } | undefined;
    if (!entry || entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
    if (!entry.data || entry.data.role !== role) continue;
    if (Math.abs((entry.data.timestamp ?? Number.NaN) - timestamp) <= DUPLICATE_WINDOW_MS) return true;
  }
  return false;
}

/**
 * Compute the prompt-cache countdown state.
 *
 * The cache stays warm for CACHE_TTL_MS after the last request that read from
 * or wrote to it; once the TTL elapses the next request is a cache miss.
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

// Sorts before "subagents-pi": Pi joins extension statuses alphabetically and
// truncates from the end, so a later key would risk being cut off.
const STATUS_KEY = "cache-timestamp-pi";

export default function timestampPiExtension(pi: ExtensionAPI) {
  let enabled = true;
  let cacheLastActive: number | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let mountedCtx: ExtensionContext | undefined;

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    mount(ctx);
  });

  pi.on("session_shutdown", async () => {
    unmount(mountedCtx);
  });

  pi.on("message_end", async (event, ctx) => {
    const message = event.message;

    if (enabled && (message.role === "user" || message.role === "assistant")) {
      const timestamp = message.timestamp ?? Date.now();
      const kind: TimestampKind =
        message.role === "user" ? "user" : isToolCallMessage(message) ? "tool" : "assistant";
      if (!hasDuplicateTimestampEntry(ctx.sessionManager.getEntries(), message.role, timestamp)) {
        pi.appendEntry<TimestampEntryData>(ENTRY_TYPE, {
          role: message.role,
          kind,
          timestamp,
        });
      }
    }

    // A response that read from or wrote to the prompt cache refreshes the TTL.
    if (
      message.role === "assistant" &&
      message.usage &&
      (message.usage.cacheRead > 0 || message.usage.cacheWrite > 0)
    ) {
      cacheLastActive = Date.now();
      syncStatus();
    }
  });

  pi.registerEntryRenderer<TimestampEntryData>(ENTRY_TYPE, (entry, _options, theme) => {
    if (!enabled || !entry.data) return undefined;
    return new Text(theme.fg("dim", formatTimestampLine(entry.data, Date.now())), 0, 0);
  });

  pi.registerCommand("timestamp-pi", {
    description: "Toggle message timestamps and cache countdown",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      if (ctx.hasUI) {
        if (enabled) {
          mount(ctx);
        } else {
          unmount(ctx);
        }
        ctx.ui.notify(`timestamp-pi ${enabled ? "enabled" : "disabled"}`, "info");
      }
    },
  });

  function ensureTimer(): void {
    if (refreshTimer) return;
    refreshTimer = setInterval(() => {
      syncStatus();
    }, 1_000);
  }

  function clearTimer(): void {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
  }

  function mount(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;

    mountedCtx = ctx;
    // Don't add a status element yet — nothing to show until cache activity
    // starts. Other extensions keep their own footer elements untouched.
    // syncStatus() starts the interval only when there is something to display.
    syncStatus();
  }

  function unmount(ctx?: ExtensionContext): void {
    clearTimer();
    if (ctx?.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
    mountedCtx = undefined;
  }

  /** Add the status element only while there's something to show; clear it otherwise. */
  function syncStatus(): void {
    if (!mountedCtx?.hasUI) return;
    const status = computeCacheStatus(cacheLastActive, Date.now());
    const hasContent = enabled && status.state !== "idle";

    if (hasContent) {
      const tone =
        status.state === "expired" ? "error" : status.remainingMs <= CACHE_WARN_MS ? "warning" : "success";
      mountedCtx.ui.setStatus(STATUS_KEY, mountedCtx.ui.theme.fg(tone, `⏳ ${status.label}`));
      ensureTimer();
    } else {
      mountedCtx.ui.setStatus(STATUS_KEY, undefined);
      clearTimer();
    }
  }
}
