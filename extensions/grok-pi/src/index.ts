import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { supportedThinkingLevels, type GrokModelInfo } from "./models.js";
import {
	PROVIDER_ID,
	checkCliStatus,
	cliStatusLines,
	grokBin,
	grokHome,
	modelsCachePath,
	readCachedModels,
	registerGrokProviderBridge,
	setupGuidance,
} from "./bridge.js";
import { grokHarnessStateIn, grokInstallGuidance, grokAuthGuidance } from "./harness.js";

function readCachedModelsForDisplay(): GrokModelInfo[] {
	return readCachedModels();
}

export default function grokPiExtension(pi: ExtensionAPI) {
	registerGrokProviderBridge(pi);

	pi.on("session_start", async (_event: any, ctx: any) => {
		const harness = grokHarnessStateIn(grokHome());
		if (!harness.installed) {
			ctx.ui.notify(grokInstallGuidance(), "warning");
			return;
		}
		if (!harness.authPresent) {
			ctx.ui.notify(grokAuthGuidance(), "warning");
			return;
		}
		const status = await checkCliStatus();
		if (!status.ok) {
			ctx.ui.notify(`grok-pi: ${setupGuidance(status.detail ?? status.summary)}`, "warning");
			return;
		}
		ctx.ui.notify(
			`grok-pi: registered ${readCachedModelsForDisplay().length} model(s); every turn spawns the local \`grok\` CLI. Use /model or --provider ${PROVIDER_ID}.`,
			"info",
		);
	});

	pi.registerCommand("grok-pi", {
		description: "Grok CLI bridge status and setup help",
		handler: async (args: string, ctx: any) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "status";

			if (sub === "status") {
				const status = await checkCliStatus();
				for (const line of cliStatusLines(status)) ctx.ui.notify(line, status.ok ? "info" : "warning");
				return;
			}

			if (sub === "models") {
				for (const info of readCachedModelsForDisplay()) {
					const levels = supportedThinkingLevels(info);
					const thinking = levels.length > 0 ? levels.join(", ") : "off";
					ctx.ui.notify(`${PROVIDER_ID}/${info.model} — ${info.name ?? info.model} [${thinking}]`, "info");
				}
				ctx.ui.notify(`Also run: pi --list-models ${PROVIDER_ID}`, "info");
				return;
			}

			if (sub === "test") {
				const smokeModel = readCachedModelsForDisplay()[0]?.model ?? "grok-4.6";
				ctx.ui.notify(
					`Run: pi -p --provider ${PROVIDER_ID} --model ${smokeModel} --thinking medium "Reply with exactly OK"`,
					"info",
				);
				ctx.ui.notify(
					`Direct transport check: ${grokBin()} --single "Reply with exactly OK" --model ${smokeModel} --tools "" --disable-web-search --permission-mode dontAsk --output-format json`,
					"info",
				);
				return;
			}

			if (sub === "help") {
				ctx.ui.notify("Usage: /grok-pi [status|models|test|help]", "info");
				ctx.ui.notify("Every model turn spawns the official `grok` CLI (`grok --prompt-file`); no direct HTTP calls.", "info");
				ctx.ui.notify("Auth and token refresh stay inside the Grok CLI — this extension never reads ~/.grok/auth.json.", "info");
				ctx.ui.notify(`Model metadata (read-only): ${modelsCachePath()}`, "info");
				ctx.ui.notify("Set GROK_PI_BIN to override the grok executable.", "info");
				ctx.ui.notify("Set GROK_PI_MODELS for a comma-separated model list override.", "info");
				ctx.ui.notify("Set GROK_PI_TIMEOUT_MS for per-turn timeout (default 300000).", "info");
				ctx.ui.notify("Set GROK_PI_HOME to override the Grok harness directory (~/.grok); also relocates the model cache.", "info");
				ctx.ui.notify("Thinking: Shift+Tab, /settings, or --thinking <low|medium|high|xhigh>", "info");
				return;
			}

			ctx.ui.notify(`Unknown /grok-pi subcommand: ${sub}. Try /grok-pi help`, "warning");
		},
	});
}
