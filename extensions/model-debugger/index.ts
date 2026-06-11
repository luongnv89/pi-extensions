import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";

const LOG_DIR = path.join(process.env.HOME || "", ".pi/agent/logs");
const LOG_FILE = path.join(LOG_DIR, "model-debugger.log");
const SETTINGS_FILE = path.join(
  process.env.HOME || "",
  ".pi/agent/settings.json",
);

// Safety limits to avoid unbounded disk consumption
const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB cap
const MAX_LOG_LINES = 10_000; // ~10K lines cap (whichever is hit first)

let currentModel: string;
let lastRequestId: string | null = null;
let requestStartTime: number = 0;
let isProcessing = false;
let enabled = true;
let enablementFile: string;

// Ensure log directory exists
try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
} catch (e) {
  console.error("Failed to create log directory:", e);
}

// Trim the log file on startup to stay within limits.
// This runs once per Pi session, so it doesn't affect runtime performance.
try {
  if (fs.existsSync(LOG_FILE)) {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_LOG_SIZE_BYTES) {
      const content = fs.readFileSync(LOG_FILE, "utf8");
      const lines = content.split("\n").filter(Boolean);
      if (lines.length > MAX_LOG_LINES) {
        // Keep only the last MAX_LOG_LINES lines
        fs.writeFileSync(
          LOG_FILE,
          lines.slice(-MAX_LOG_LINES).join("\n") + "\n",
        );
      } else {
        // Keep only the last 50% of content as a rough trim
        const keepIndex = Math.floor(lines.length / 2);
        fs.writeFileSync(LOG_FILE, lines.slice(keepIndex).join("\n") + "\n");
      }
    }
  }
} catch (e) {
  // Silently ignore trim errors
}

// Read the currently active model from Pi's settings at startup.
// This handles the case where Pi has already selected a model before the extension is loaded.
function readModelFromSettings(): string {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
      const provider = settings.defaultProvider;
      const model = settings.defaultModel;
      if (provider && model) {
        return `${provider}/${model}`;
      }
      if (model) {
        return model;
      }
    }
  } catch (e) {
    // ignore read errors
  }
  return "unknown";
}

// Also expose SETTINGS_FILE so /debug-status can show it
const SETTINGS_FILE_FOR_DISPLAY = SETTINGS_FILE;

// Persist enable/disable state across Pi sessions via a marker file.
function persistEnabledState(val: boolean) {
  try {
    if (val) {
      // Write a dot file so we know the extension was once enabled
      fs.writeFileSync(enablementFile, "enabled");
    } else {
      fs.writeFileSync(enablementFile, "disabled");
    }
  } catch {
    /* ignore */
  }
}

function readEnabledState(): boolean {
  try {
    if (fs.existsSync(enablementFile)) {
      const state = fs.readFileSync(enablementFile, "utf8").trim();
      return state !== "disabled";
    }
  } catch {
    /* ignore */
  }
  return true; // default: enabled
}

enablementFile = path.join(LOG_DIR, ".model-debugger-state");
enabled = readEnabledState();
currentModel = readModelFromSettings();

// Sensitive HTTP header keys to redact from logs (prevent token/API-key leakage)
const SENSITIVE_HEADER_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-api-key",
  "x-client-secret",
  "x-auth-token",
  "x-forwarded-for",
]);

function sanitizeHeaders(headers: Record<string, string> | null): Record<string, string> {
  if (!headers) return {};
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_KEYS.has(key.toLowerCase())) {
      sanitized[key] = "[REDACTED]";
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function log(
  level: "info" | "warn" | "error",
  message: string,
  data?: unknown,
) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  let dataStr = "";
  if (data) {
    try {
      dataStr = " " + JSON.stringify(data);
    } catch {
      dataStr = " [data serialization failed]";
    }
  }

  // Write only to the log file, never to console.
  // console.log would mix with the response stream of an ongoing session.
  // Use /debug-logs to view the file on demand.
  try {
    fs.appendFileSync(LOG_FILE, logEntry + dataStr + "\n");
  } catch {
    // Silently fail if we can't write to log file
  }
}

export default function (pi: ExtensionAPI) {
  log("info", "🚀 Model Debugger extension loaded");
  log("info", `📁 Log file: ${LOG_FILE}`);

  // If starting disabled, log a single line and skip event handlers
  if (!enabled) {
    log("info", "🔇 Model Debugger is DISABLED. Run /debug-toggle to enable.");
  }

  // Guard helper: skip if disabled
  function guard(): boolean {
    return !enabled;
  }

  // Track model changes
  pi.on("model_select", async (event, ctx) => {
    if (guard()) return;
    const modelStr = `${event.model.provider}/${event.model.id}`;
    currentModel = modelStr;
    log("info", `🔄 Model selected: ${modelStr} (source: ${event.source})`);
  });

  // Agent starting - new request beginning
  pi.on("agent_start", async (event, ctx) => {
    if (guard()) return;
    lastRequestId = generateId();
    requestStartTime = Date.now();
    isProcessing = true;

    // If model is still unknown, try to read from settings again
    // (catches edge case where settings changed between init and first request)
    if (currentModel === "unknown") {
      currentModel = readModelFromSettings();
    }

    log("info", `▶️ === Agent Start [${lastRequestId}] ===`, {
      model: currentModel,
      timestamp: new Date().toISOString(),
    });
  });

  // Before provider request - payload going out
  pi.on("before_provider_request", async (event, ctx) => {
    if (guard()) return;
    log("info", `📤 Provider Request [${lastRequestId}]`, {
      model: currentModel,
      timestamp: new Date().toISOString(),
      payloadSize: (() => {
        try {
          return JSON.stringify(event.payload).length;
        } catch {
          return 0;
        }
      })(),
    });
  });

  // After provider response - first response received
  pi.on("after_provider_response", async (event, ctx) => {
    if (guard()) return;
    const elapsed = requestStartTime ? Date.now() - requestStartTime : 0;

    log(
      typeof event.status === "number" && event.status >= 400 ? "error" : "info",
      `📥 Provider Response [${lastRequestId}]`,
      {
        model: currentModel,
        status: event.status,
        elapsedMs: elapsed,
        headers: sanitizeHeaders(event.headers),
        timestamp: new Date().toISOString(),
      },
    );
  });

  // Message starting (token stream beginning)
  pi.on("message_start", async (event, ctx) => {
    if (guard()) return;
    log("info", `💬 Message Start [${lastRequestId}]`, {
      role: event.message.role,
      model: currentModel,
    });
  });

  // Message updates (streaming tokens)
  let updateCount = 0;
  pi.on("message_update", async (event, ctx) => {
    if (guard()) return;
    updateCount++;
    // Log every 50th update to avoid spam, but also log the first few
    if (updateCount <= 3 || updateCount % 50 === 0) {
      log("info", `📝 Message Update #${updateCount} [${lastRequestId}]`, {
        hasContent: !!event.message.content,
        model: currentModel,
      });
    }
  });

  // Message ended
  pi.on("message_end", async (event, ctx) => {
    if (guard()) return;
    const elapsed = requestStartTime ? Date.now() - requestStartTime : 0;

    // Check for empty/suspicious responses
    const content = event.message.content;
    let isEmpty = false;
    if (!content) {
      isEmpty = true;
    } else if (Array.isArray(content) && content.length === 0) {
      isEmpty = true;
    } else if (typeof content === "string" && content.trim().length === 0) {
      isEmpty = true;
    }

    log(isEmpty ? "warn" : "info", `🏁 Message End [${lastRequestId}]`, {
      role: event.message.role,
      model: currentModel,
      elapsedMs: elapsed,
      isEmpty,
      contentLength:
        typeof content === "string"
          ? content.length
          : JSON.stringify(content).length,
      usage: event.message.usage,
      updateCount,
    });

    updateCount = 0; // Reset for next message
  });

  // Turn ended
  pi.on("turn_end", async (event, ctx) => {
    if (guard()) return;
    const elapsed = requestStartTime ? Date.now() - requestStartTime : 0;
    log("info", `🔚 Turn End [${lastRequestId}]`, {
      model: currentModel,
      elapsedMs: elapsed,
      turnIndex: event.turnIndex,
      hasToolResults: !!event.toolResults?.length,
    });
  });

  // Agent finished
  pi.on("agent_end", async (event, ctx) => {
    if (guard()) return;
    const elapsed = requestStartTime ? Date.now() - requestStartTime : 0;
    isProcessing = false;

    // Analyze if we got any actual response
    const messages = event.messages || [];
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    const lastAssistantMessage =
      assistantMessages[assistantMessages.length - 1];

    let isSilentFailure = false;
    let failureReason = "";

    if (!lastAssistantMessage) {
      isSilentFailure = true;
      failureReason = "No assistant message received";
    } else if (!lastAssistantMessage.content) {
      // Allow tool-call-only responses (content empty but toolCalls populated)
      if (lastAssistantMessage.toolCalls?.length) {
        isSilentFailure = false;
      } else {
        isSilentFailure = true;
        failureReason = "Assistant message has no content";
      }
    } else if (
      Array.isArray(lastAssistantMessage.content) &&
      lastAssistantMessage.content.length === 0
    ) {
      isSilentFailure = true;
      failureReason = "Assistant message has empty content array";
    } else if (
      typeof lastAssistantMessage.content === "string" &&
      lastAssistantMessage.content.trim().length === 0
    ) {
      isSilentFailure = true;
      failureReason = "Assistant message content is empty string";
    }

    log(
      isSilentFailure ? "error" : "info",
      `⛔ Agent End [${lastRequestId}] ===`,
      {
        model: currentModel,
        elapsedMs: elapsed,
        totalMessages: messages.length,
        assistantMessages: assistantMessages.length,
        isSilentFailure,
        failureReason: failureReason || undefined,
      },
    );

    // Alert user of suspected silent failure
    if (isSilentFailure) {
      log("error", "🚨 SILENT FAILURE DETECTED", {
        model: currentModel,
        requestId: lastRequestId,
        elapsedMs: elapsed,
        reason: failureReason,
      });

      ctx.ui?.notify(
        `⚠️ Silent failure with ${currentModel}! Check: ${LOG_FILE}`,
        "error",
      );
    }
  });

  // Register /debug-logs command
  pi.registerCommand("debug-logs", {
    description: "Show last N model debugger log entries (default: 100)",
    handler: async (args, ctx) => {
      try {
        const parsed = Math.floor(parseInt(args, 10));
        const lines = parsed && parsed > 0 ? parsed : 100;
        const logs = fs.readFileSync(LOG_FILE, "utf8");
        const logLines = logs.split("\n").filter(Boolean);
        const lastLines = logLines.slice(-lines);

        console.log(`\n📋 === Last ${lines} log entries ===\n`);
        console.log(lastLines.join("\n"));
        console.log("\n" + "=".repeat(50) + "\n");
      } catch (e) {
        ctx.ui?.notify("No logs found yet", "warning");
      }
    },
  });

  // Register /debug-status command for quick status check
  pi.registerCommand("debug-status", {
    description: "Show model debugger status",
    handler: async (args, ctx) => {
      const status = {
        enabled,
        currentModel,
        lastRequestId,
        isProcessing,
        logFile: LOG_FILE,
        settingsFile: SETTINGS_FILE_FOR_DISPLAY,
        uptime: requestStartTime ? Date.now() - requestStartTime : 0,
      };

      console.log("\n🔍 Model Debugger Status:\n");
      console.log(JSON.stringify(status, null, 2));
      console.log("\n");
    },
  });

  // Register /debug-toggle command to enable/disable at runtime
  pi.registerCommand("debug-toggle", {
    description:
      "Enable or disable model debugger logging. Usage: /debug-toggle [on|off] (default: toggle)",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (arg === "on" || arg === "enable") {
        enabled = true;
      } else if (arg === "off" || arg === "disable") {
        enabled = false;
      } else {
        enabled = !enabled;
      }
      persistEnabledState(enabled);
      const state = enabled ? "🟢 enabled" : "🔴 disabled";
      ctx.ui?.notify(`Model Debugger is ${state}`, enabled ? "info" : "warning");
      log("info", `🔁 Model Debugger toggled: ${state}`);
    },
  });

  // Register /debug-clear command to clear the log file
  pi.registerCommand("debug-clear", {
    description: "Clear the model debugger log file",
    handler: async (args, ctx) => {
      try {
        fs.writeFileSync(LOG_FILE, "");
        ctx.ui?.notify("🧹 Log file cleared", "info");
      } catch (e) {
        ctx.ui?.notify("Failed to clear log file", "error");
      }
    },
  });

  // Register /debug-help command to list all debug commands
  pi.registerCommand("debug-help", {
    description: "Show all model debugger commands",
    handler: async (args, ctx) => {
      const state = enabled ? "🟢 enabled" : "🔴 disabled";
      console.log(`
🔍 Model Debugger — ${state}

Commands:
  /debug-status              Show current debugger status
  /debug-toggle [on|off]     Enable or disable logging (persisted across restarts)
  /debug-logs [N]            Show last N log entries (default: 100)
  /debug-clear               Clear the log file
  /debug-help                Show this help

Log file: ${LOG_FILE}
`);
    },
  });

  log(
    "info",
    `✅ Model Debugger extension initialized (${enabled ? "enabled" : "disabled"})`,
  );
}
