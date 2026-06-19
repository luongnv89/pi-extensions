import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CONTEXT_WINDOW_NOTE,
	loadAppleFmConfig,
	PCC_FOREGROUND_NOTE,
	PROVIDER_ID,
} from "./config.js";
import {
	ensureFmServe,
	fetchHealth,
	launchStackInTerminal,
	startStack,
	stopFmServe,
} from "./fm-server.js";
import { buildProviderModels, STATIC_MODELS } from "./models.js";
import { streamAppleFm } from "./stream-fm.js";

const execFileAsync = promisify(execFile);

function registerAppleFmProvider(pi: ExtensionAPI) {
	const cfg = loadAppleFmConfig();
	pi.registerProvider(PROVIDER_ID, {
		name: "Apple Foundation Models",
		baseUrl: cfg.baseUrl,
		api: "openai-completions",
		apiKey: "sk-apple-fm-pi",
		models: buildProviderModels(cfg),
		...(cfg.useProxy ? {} : { streamSimple: streamAppleFm }),
	});
}

async function fmInstalled(bin: string): Promise<boolean> {
	try {
		await execFileAsync(bin, ["--help"], { timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

function statusLines(): string[] {
	const cfg = loadAppleFmConfig();
	const lines: string[] = [];
	lines.push(`Provider: ${PROVIDER_ID}`);
	lines.push(`Pi base URL: ${cfg.baseUrl}`);
	lines.push(
		`Mode: ${cfg.useProxy ? `external fm-proxy :${cfg.proxyPort} → fm :${cfg.fmPort}` : `in-process tool fix → fm :${cfg.fmPort}`}`,
	);
	lines.push(`fm binary: ${cfg.fmBin}`);
	lines.push(`Auto-start: ${cfg.autoStart ? "yes" : "no"}`);
	lines.push(`Context window (Pi): ${cfg.contextWindow}`);
	lines.push("");
	lines.push("Models:");
	for (const m of STATIC_MODELS) {
		lines.push(`  - ${m.id}: ${m.name}`);
	}
	lines.push("");
	lines.push(CONTEXT_WINDOW_NOTE);
	lines.push(PCC_FOREGROUND_NOTE);
	lines.push("");
	lines.push("Commands:");
	lines.push("  /apple-fm-pi status");
	lines.push("  /apple-fm-pi start          — background fm + fm-proxy (system; pcc often 503)");
	lines.push("  /apple-fm-pi launch-terminal — macOS Terminal + foreground fm (best for pcc)");
	lines.push("  /apple-fm-pi stop");
	lines.push("  /apple-fm-pi models | context | test [system|pcc] | reload | help");
	return lines;
}

export default function appleFmPiExtension(pi: ExtensionAPI) {
	registerAppleFmProvider(pi);

	pi.on("session_start", async (_event, ctx) => {
		const cfg = loadAppleFmConfig();
		if (!(await fmInstalled(cfg.fmBin))) {
			ctx.ui.notify(
				`apple-fm-pi: \`${cfg.fmBin}\` not found. Install Apple's Foundation Models CLI.`,
				"warning",
			);
			return;
		}

		const result = await ensureFmServe(cfg);
		if (!result.ok) {
			ctx.ui.notify(`apple-fm-pi: ${result.message}`, "warning");
			if (cfg.useProxy) {
				ctx.ui.notify(
					"Tip: /apple-fm-pi launch-terminal for PCC, or /apple-fm-pi start for background stack.",
					"info",
				);
			}
			return;
		}

			ctx.ui.notify(
			`apple-fm-pi: ready at ${cfg.baseUrl} (${cfg.useProxy ? "HTTP fm-proxy" : "in-process tool schema fix"}). system ctx=${cfg.contextWindow}.`,
			"info",
		);
		ctx.ui.notify(
			"Use apple-fm/system for agent work. pcc only after /apple-fm-pi launch-terminal (foreground fm).",
			"info",
		);
	});

	pi.on("model_select", async (event, ctx) => {
		if (event.model.provider !== PROVIDER_ID) return;
		if (event.model.id === "pcc") {
			const health = await fetchHealth(loadAppleFmConfig());
			const pcc = health.health?.models?.find((x) => x.name === "pcc");
			if (pcc?.available === false) {
				ctx.ui.notify(
					`apple-fm/pcc: ${pcc.reason ?? "unavailable"}. Run /apple-fm-pi launch-terminal, keep Terminal open, then retry.`,
					"warning",
				);
			} else {
				ctx.ui.notify(
					"apple-fm/pcc: use /apple-fm-pi launch-terminal if you get 503 (background fm lacks PCC attribution).",
					"info",
				);
			}
		}
		if (event.model.id === "system") {
			ctx.ui.notify(
				"apple-fm/system: small context (~4k). Start a fresh session if you see 'exceeded context size'.",
				"info",
			);
		}
	});

	pi.registerCommand("apple-fm-pi", {
		description: "Apple FM + fm-proxy stack",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "status";
			const cfg = loadAppleFmConfig();

			if (sub === "help") {
				for (const line of statusLines()) ctx.ui.notify(line, "info");
				return;
			}

			if (sub === "status") {
				const health = await fetchHealth(cfg);
				for (const line of statusLines()) ctx.ui.notify(line, "info");
				ctx.ui.notify(
					health.running
						? `Server: up (${health.url}${health.viaProxy ? ", via fm-proxy" : ""})`
						: `Server: down (${health.error ?? "unreachable"})`,
					health.running ? "info" : "warning",
				);
				return;
			}

			if (sub === "start") {
				const result = await startStack(cfg);
				ctx.ui.notify(result.message, result.ok ? "info" : "error");
				if (result.ok) {
					ctx.ui.notify(PCC_FOREGROUND_NOTE, "info");
				}
				return;
			}

			if (sub === "launch-terminal" || sub === "lauch-terminal" || sub === "terminal") {
				const result = await launchStackInTerminal(cfg);
				ctx.ui.notify(result.message, result.ok ? "info" : "error");
				return;
			}

			if (sub === "stop") {
				const result = await stopFmServe(cfg);
				ctx.ui.notify(result.message, result.ok ? "info" : "warning");
				return;
			}

			if (sub === "models") {
				const health = await fetchHealth(cfg);
				for (const m of STATIC_MODELS) {
					const live = health.health?.models?.find((x) => x.name === m.id);
					const avail =
						live?.available === true
							? "available"
							: live?.available === false
								? `unavailable${live.reason ? `: ${live.reason}` : ""}`
								: health.running
									? "unknown"
									: "server down";
					ctx.ui.notify(`${m.id} — ${m.name} [${avail}]`, "info");
				}
				return;
			}

			if (sub === "context") {
				ctx.ui.notify(`contextWindow=${cfg.contextWindow}, maxTokens=${cfg.maxTokens}`, "info");
				ctx.ui.notify(CONTEXT_WINDOW_NOTE, "info");
				return;
			}

			if (sub === "reload") {
				try {
					registerAppleFmProvider(pi);
					ctx.ui.notify("apple-fm-pi: provider re-registered.", "info");
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					ctx.ui.notify(`reload failed: ${message}. Use /reload`, "warning");
				}
				return;
			}

			if (sub === "test") {
				const model = parts[1] ?? "system";
				if (!STATIC_MODELS.some((m) => m.id === model)) {
					ctx.ui.notify(`Unknown model '${model}'.`, "error");
					return;
				}
				const stack = await ensureFmServe(cfg);
				if (!stack.ok) {
					ctx.ui.notify(stack.message, "error");
					return;
				}
				try {
					const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: "Bearer sk-apple-fm-pi",
						},
						body: JSON.stringify({
							model,
							messages: [{ role: "user", content: "Reply with exactly: OK" }],
							max_tokens: 16,
						}),
					});
					const text = await res.text();
					if (!res.ok) {
						ctx.ui.notify(`Test HTTP ${res.status}: ${text.slice(0, 240)}`, "error");
						return;
					}
					ctx.ui.notify(`Test OK (${model}): ${text.slice(0, 160)}`, "info");
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					ctx.ui.notify(`Test error: ${message}`, "error");
				}
				return;
			}

			const hint =
				sub === "lauch-terminal" || sub.includes("lauch")
					? " Did you mean launch-terminal?"
					: "";
			ctx.ui.notify(`Unknown '${sub}'.${hint} Try /apple-fm-pi help`, "warning");
		},
	});
}