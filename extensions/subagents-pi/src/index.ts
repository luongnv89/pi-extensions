import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isCompanionLoaded } from "./registry.js";
import { renderFleetLines, WIDGET_KEY } from "./render.js";
import { SubagentMetricsStore } from "./store.js";
import { loadPreferences, savePreferences } from "./preferences.js";

export { loadPreferences, preferencesPath, savePreferences } from "./preferences.js";
export type { SubagentsPreferences, SubagentsPreferencesPatch } from "./preferences.js";

interface LifecyclePayload {
	id?: unknown;
}

interface RpcSpawnRequest {
	requestId?: unknown;
}

interface RpcSpawnReply {
	success?: unknown;
	data?: { id?: unknown };
}

const REFRESH_MS = 500;
type ModeAwareContext = ExtensionContext & { mode?: string };

export default function subagentsPiExtension(pi: ExtensionAPI) {
	let enabled = loadPreferences()?.enabled ?? true;
	let mounted = false;
	let activeCtx: ExtensionContext | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let renderRequested: (() => void) | undefined;
	const store = new SubagentMetricsStore();

	const unsubscribers: Array<() => void> = [];
	const rpcReplyUnsubscribers = new Set<() => void>();

	function nonEmptyString(value: unknown): string | undefined {
		return typeof value === "string" && value.trim().length > 0 ? value : undefined;
	}

	function trackFromPayload(payload: unknown): void {
		const id = nonEmptyString((payload as LifecyclePayload)?.id);
		if (id) store.trackId(id);
	}

	function tearDownEventBus(): void {
		for (const unsub of rpcReplyUnsubscribers) unsub();
		rpcReplyUnsubscribers.clear();
		for (const unsub of unsubscribers) unsub();
		unsubscribers.length = 0;
	}

	function wireEventBus(): void {
		tearDownEventBus();
		const events = pi.events;
		if (!events?.on) return;

		const trackRpcSpawn = (payload: unknown): void => {
			const requestId = nonEmptyString((payload as RpcSpawnRequest)?.requestId);
			if (!requestId) return;

			let unsubscribe: (() => void) | undefined;
			unsubscribe = events.on(`subagents:rpc:spawn:reply:${requestId}`, (replyPayload) => {
				unsubscribe?.();
				if (unsubscribe) rpcReplyUnsubscribers.delete(unsubscribe);

				const reply = replyPayload as RpcSpawnReply;
				const id = reply?.success === true ? nonEmptyString(reply.data?.id) : undefined;
				if (id) store.trackId(id);
			});
			rpcReplyUnsubscribers.add(unsubscribe);
		};

		const handlers: Array<[string, (data: unknown) => void]> = [
			["subagents:ready", () => store.markCompanionReady()],
			["subagents:created", trackFromPayload],
			["subagents:started", trackFromPayload],
			["subagents:completed", trackFromPayload],
			["subagents:failed", trackFromPayload],
			["subagents:compacted", trackFromPayload],
			["subagents:steered", trackFromPayload],
			["subagents:rpc:spawn", trackRpcSpawn],
		];

		for (const [name, handler] of handlers) {
			const unsub = events.on(name, handler);
			if (typeof unsub === "function") unsubscribers.push(unsub);
		}
	}

	wireEventBus();
	if (isCompanionLoaded()) store.markCompanionReady();

	pi.on("session_start", async (_event, ctx) => {
		store.reset();
		wireEventBus();
		if (isCompanionLoaded()) store.markCompanionReady();
		if (!ctx.hasUI) return;
		mount(ctx);
	});

	pi.on("session_shutdown", async () => {
		unmount(activeCtx);
		activeCtx = undefined;
		store.reset();
		tearDownEventBus();
	});

	pi.registerCommand("subagents-pi", {
		description: "Toggle subagent fleet metrics panel (context, TPS, model, thinking)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const command = typeof args === "string" ? args.trim().toLowerCase() : "";
			if (!command && isTuiContext(ctx)) {
				await openConfigPanel(ctx);
				return;
			}

			if (command === "" || command === "toggle") {
				await setEnabled(!enabled, ctx);
				return;
			}
			if (command === "on" || command === "enable") {
				await setEnabled(true, ctx);
				return;
			}
			if (command === "off" || command === "disable") {
				await setEnabled(false, ctx);
				return;
			}

			if (ctx.hasUI) ctx.ui.notify("Usage: /subagents-pi [toggle|on|off]", "error");
		},
	});

	pi.registerCommand("subagents-pi-refresh", {
		description: "Refresh subagent fleet metrics display",
		handler: async (_args, ctx) => {
			refreshDisplay(ctx);
		},
	});

	async function openConfigPanel(ctx: ExtensionContext): Promise<void> {
		const nextEnabled = !enabled;
		const toggleLabel = nextEnabled
			? "Enable subagents-pi (currently disabled)"
			: "Disable subagents-pi (currently enabled)";
		const choice = await ctx.ui.select("subagents-pi", [toggleLabel, "Refresh", "Close"]);
		if (choice === undefined || choice === "Close") return;
		if (choice === "Refresh") {
			refreshDisplay(ctx);
			return;
		}
		if (choice === toggleLabel) await setEnabled(nextEnabled, ctx);
	}

	async function setEnabled(next: boolean, ctx: ExtensionContext): Promise<void> {
		enabled = next;
		if (!savePreferences(enabled) && ctx.hasUI) {
			ctx.ui.notify("Could not save subagents-pi preference; this change applies to the current session only.", "warning");
		}
		if (enabled) {
			mount(ctx);
		} else {
			unmount(ctx);
		}
		if (ctx.hasUI) ctx.ui.notify(`subagents-pi ${enabled ? "enabled" : "disabled"}`, "info");
	}

	function refreshDisplay(ctx: ExtensionContext): void {
		store.pruneMissing();
		store.pruneTerminal();
		requestRender();
		if (ctx.hasUI) ctx.ui.notify("subagents-pi refreshed", "info");
	}

	function mount(ctx: ExtensionContext): void {
		if (!enabled || !ctx.hasUI) return;
		if (mounted && activeCtx === ctx) return;
		if (mounted) unmount(activeCtx);
		mounted = true;
		activeCtx = ctx;

		ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => {
			renderRequested = () => _tui.requestRender();
			return {
				invalidate() {
					_tui.requestRender();
				},
				render(width: number): string[] {
					store.pruneMissing();
					store.pruneTerminal();
					const rows = store.listRows();
					return renderFleetLines(theme, rows, {
						companionReady: store.isCompanionReady() || isCompanionLoaded(),
						enabled,
					}, width);
				},
			};
		}, { placement: "belowEditor" });

		ctx.ui.setStatus(
			"subagents-pi",
			ctx.ui.theme.fg("accent", `subagents:${store.visibleCount()}`),
		);

		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = setInterval(() => {
			store.pruneMissing();
			store.pruneTerminal();
			requestRender();
			updateStatus(ctx);
		}, REFRESH_MS);
	}

	function unmount(ctx?: ExtensionContext): void {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
		renderRequested = undefined;
		mounted = false;
		if (activeCtx === ctx) activeCtx = undefined;
		if (ctx?.hasUI) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			ctx.ui.setStatus("subagents-pi", undefined);
		}
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("subagents-pi", ctx.ui.theme.fg("accent", `subagents:${store.visibleCount()}`));
	}

	function requestRender(): void {
		renderRequested?.();
	}
}

function isTuiContext(ctx: ExtensionContext): boolean {
	return (ctx as ModeAwareContext).mode === "tui" && ctx.hasUI;
}