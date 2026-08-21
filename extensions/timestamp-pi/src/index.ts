import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** Custom entry type used for per-message timestamps (TUI-only, never sent to the LLM). */
export const ENTRY_TYPE = "timestamp-pi";

/** Prompt cache TTL (Anthropic default is 5 minutes). */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/** Warn when less than this time remains before the cache expires. */
export const CACHE_WARN_MS = 60 * 1000;

export interface TimestampEntryData {
  role: "user" | "assistant";
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

/** Format a relative age: "now", "5s ago", "2m ago", "3h ago". */
export function formatRelative(ts: number, now: number): string {
  const diff = Math.max(0, Math.floor((now - ts) / 1000));
  if (diff < 5) return "now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

/** Format a countdown as m:ss, clamped at 0:00. */
export function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** One-line timestamp marker rendered under a message. */
export function formatTimestampLine(data: TimestampEntryData, now: number): string {
  return `⏱ ${formatClock(data.timestamp)} (${formatRelative(data.timestamp, now)})`;
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

export default function timestampPiExtension(pi: ExtensionAPI) {
  let enabled = true;
  let cacheLastActive: number | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let requestRender: (() => void) | undefined;

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    mount(ctx);
  });

  pi.on("session_shutdown", async () => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    requestRender = undefined;
    cacheLastActive = undefined;
  });

  pi.on("message_end", async (event) => {
    const message = event.message;

    if (enabled && (message.role === "user" || message.role === "assistant")) {
      pi.appendEntry<TimestampEntryData>(ENTRY_TYPE, {
        role: message.role,
        timestamp: message.timestamp ?? Date.now(),
      });
    }

    // A response that read from or wrote to the prompt cache refreshes the TTL.
    if (
      message.role === "assistant" &&
      message.usage &&
      (message.usage.cacheRead > 0 || message.usage.cacheWrite > 0)
    ) {
      cacheLastActive = Date.now();
      requestRender?.();
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

  function mount(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;

    ctx.ui.setFooter((tui, theme, _footerData) => {
      requestRender = () => tui.requestRender();

      return {
        dispose() {
          requestRender = undefined;
        },
        invalidate() {
          tui.requestRender();
        },
        render(_width: number): string[] {
          const status = computeCacheStatus(cacheLastActive, Date.now());
          if (!enabled || status.state === "idle") return [];

          const tone =
            status.state === "expired" ? "error" : status.remainingMs <= CACHE_WARN_MS ? "warning" : "success";
          const text = theme.fg(tone, `⏳ ${status.label}`);

          return [text];
        },
      };
    });

    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      requestRender?.();
    }, 1_000);
  }

  function unmount(ctx: ExtensionContext): void {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    requestRender = undefined;
    ctx.ui.setFooter(undefined);
  }
}
