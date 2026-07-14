import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isCompanionLoaded } from "./registry.js";
import { renderFleetLines, WIDGET_KEY } from "./render.js";
import { SubagentMetricsStore } from "./store.js";

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

export default function subagentsPiExtension(pi: ExtensionAPI) {
	let enabled = true;
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
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			enabled = !enabled;
			if (enabled) {
				mount(ctx);
				ctx.ui.notify("subagents-pi enabled", "info");
			} else {
				unmount(ctx);
				ctx.ui.notify("subagents-pi disabled", "info");
			}
		},
	});

	pi.registerCommand("subagents-pi-refresh", {
		description: "Refresh subagent fleet metrics display",
		handler: async (_args, ctx) => {
			store.pruneMissing();
			requestRender();
			ctx.ui.notify("subagents-pi refreshed", "info");
		},
	});

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