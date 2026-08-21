import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface TimestampInfo {
  lastUserMessage: number | undefined;
  lastAssistantMessage: number | undefined;
  lastToolCall: number | undefined;
  messageCount: number;
}

const RENDER_THROTTLE_MS = 500;
const NARROW_WIDTH_RATIO = 0.5;
const MIN_NARROW_WIDTH = 10;

export default function timestampPiExtension(pi: ExtensionAPI) {
  let enabled = true;
  let timestampInfo: TimestampInfo = {
    lastUserMessage: undefined,
    lastAssistantMessage: undefined,
    lastToolCall: undefined,
    messageCount: 0,
  };
  let renderRequested: (() => void) | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let lastRender = 0;

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    mount(ctx);
  });

  pi.on("session_shutdown", async () => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    renderRequested = undefined;
    timestampInfo = {
      lastUserMessage: undefined,
      lastAssistantMessage: undefined,
      lastToolCall: undefined,
      messageCount: 0,
    };
  });

  pi.on("message_start", async (event, _ctx) => {
    if (event.message.role === "user") {
      timestampInfo.lastUserMessage = Date.now();
    } else if (event.message.role === "assistant") {
      timestampInfo.lastAssistantMessage = Date.now();
    }
    requestRender();
  });

  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role === "user") {
      timestampInfo.lastUserMessage = Date.now();
    } else if (event.message.role === "assistant") {
      timestampInfo.lastAssistantMessage = Date.now();
    }
    timestampInfo.messageCount++;
    requestRender();
  });

  pi.on("tool_result", async (_event, _ctx) => {
    timestampInfo.lastToolCall = Date.now();
    requestRender();
  });

  pi.on("model_select", async (_event, _ctx) => {
    requestRender();
  });

  // Register toggle command
  pi.registerCommand("timestamp-pi", {
    description: "Toggle timestamp display in Pi footer",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      enabled = !enabled;

      if (enabled) {
        mount(ctx);
        ctx.ui.notify("timestamp-pi enabled", "info");
      } else {
        unmount(ctx);
        ctx.ui.notify("timestamp-pi disabled", "info");
      }
    },
  });

  function mount(ctx: ExtensionContext): void {
    if (!enabled || !ctx.hasUI) return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      renderRequested = () => tui.requestRender();

      return {
        dispose() {
          // nothing to clean up
        },
        invalidate() {
          tui.requestRender();
        },
        render(width: number): string[] {
          if (!enabled) return [];

          const now = Date.now();
          if (now - lastRender < RENDER_THROTTLE_MS) return [];
          lastRender = now;

          const parts: string[] = [];

          // Format timestamp helper
          function formatTime(ts: number | undefined): string {
            if (!ts) return "--:--:--";
            const d = new Date(ts);
            return d.toLocaleTimeString("en-US", { hour12: false });
          }

          // Format relative time helper
          function formatRelative(ts: number | undefined): string {
            if (!ts) return "";
            const diff = Math.floor((now - ts) / 1000);
            if (diff < 5) return "now";
            if (diff < 60) return `${diff}s ago`;
            if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
            return `${Math.floor(diff / 3600)}h ago`;
          }

          // User message timestamp
          if (timestampInfo.lastUserMessage !== undefined) {
            const timeStr = formatTime(timestampInfo.lastUserMessage);
            const relStr = formatRelative(timestampInfo.lastUserMessage);
            parts.push(theme.fg("mdLink", `User: ${timeStr} (${relStr})`));
          }

          // Assistant message timestamp
          if (timestampInfo.lastAssistantMessage !== undefined) {
            const timeStr = formatTime(timestampInfo.lastAssistantMessage);
            const relStr = formatRelative(timestampInfo.lastAssistantMessage);
            parts.push(theme.fg("success", `AI: ${timeStr} (${relStr})`));
          }

          // Tool call timestamp
          if (timestampInfo.lastToolCall !== undefined) {
            const relStr = formatRelative(timestampInfo.lastToolCall);
            parts.push(theme.fg("warning", `Tool: ${relStr}`));
          }

          // Message count
          if (timestampInfo.messageCount > 0) {
            parts.push(theme.fg("muted", `${timestampInfo.messageCount} msgs`));
          }

          if (parts.length === 0) return [];

          const separator = theme.fg("borderMuted", "  ");
          const joined = parts.join(separator);
          const narrowWidth = Math.max(MIN_NARROW_WIDTH, Math.floor(width * NARROW_WIDTH_RATIO));

          // Truncate if too long
          if (visibleWidth(joined) > width - 20) {
            // Show compact format
            const compactParts: string[] = [];
            if (timestampInfo.lastUserMessage !== undefined) {
              compactParts.push(formatTime(timestampInfo.lastUserMessage));
            }
            if (timestampInfo.lastAssistantMessage !== undefined) {
              compactParts.push(formatTime(timestampInfo.lastAssistantMessage));
            }
            if (compactParts.length > 0) {
              return [theme.fg("mdLink", `⏱ ${compactParts.join(" / ")}`)];
            }
          }

          return [joined];
        },
      };
    });

    // Periodic refresh to update "X ago" displays
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      requestRender();
    }, 10_000);
  }

  function unmount(ctx: ExtensionContext): void {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    renderRequested = undefined;
    ctx.ui.setFooter(undefined);
  }

  function requestRender(): void {
    renderRequested?.();
  }
}
