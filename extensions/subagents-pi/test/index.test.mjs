import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import subagentsPiExtension from "../dist/index.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

function createEventBus() {
	const listeners = new Map();
	return {
		emit(channel, data) {
			for (const handler of [...(listeners.get(channel) ?? [])]) handler(data);
		},
		on(channel, handler) {
			const handlers = listeners.get(channel) ?? new Set();
			handlers.add(handler);
			listeners.set(channel, handlers);
			return () => handlers.delete(handler);
		},
		listenerCount(channel) {
			return listeners.get(channel)?.size ?? 0;
		},
	};
}

function createHarness(records) {
	const events = createEventBus();
	const lifecycleHandlers = new Map();
	const widgets = new Map();
	const theme = {
		bold: (text) => text,
		fg: (_color, text) => text,
	};
	const ctx = {
		hasUI: true,
		ui: {
			theme,
			notify() {},
			setStatus() {},
			setWidget(key, widget) {
				if (widget) widgets.set(key, widget);
				else widgets.delete(key);
			},
		},
	};
	const pi = {
		events,
		on(name, handler) {
			lifecycleHandlers.set(name, handler);
		},
		registerCommand() {},
	};

	globalThis[MANAGER_KEY] = {
		getRecord: (id) => records.get(id),
		hasRunning: () => [...records.values()].some((record) => record.status === "running"),
	};

	subagentsPiExtension(pi);
	return { ctx, events, lifecycleHandlers, theme, widgets };
}

afterEach(() => {
	delete globalThis[MANAGER_KEY];
});

describe("subagents-pi extension", () => {
	it("tracks queued agents from scoped RPC replies and cleans reply listeners", async () => {
		const record = {
			id: "rpc-agent",
			type: "general-purpose",
			description: "RPC queued agent",
			status: "queued",
			toolUses: 0,
			startedAt: Date.now(),
			lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
			compactionCount: 0,
		};
		const records = new Map([[record.id, record]]);
		const { ctx, events, lifecycleHandlers, theme, widgets } = createHarness(records);
		await lifecycleHandlers.get("session_start")({}, ctx);

		const requestId = "request-1";
		const replyChannel = `subagents:rpc:spawn:reply:${requestId}`;
		events.emit("subagents:rpc:spawn", { requestId });
		assert.equal(events.listenerCount(replyChannel), 1);

		events.emit(replyChannel, { success: true, data: { id: record.id } });
		assert.equal(events.listenerCount(replyChannel), 0);

		const widgetFactory = widgets.get("subagents-pi-fleet");
		const widget = widgetFactory({ requestRender() {} }, theme);
		assert.match(widget.render(120).join("\n"), /RPC queued agent/);

		const pendingReplyChannel = "subagents:rpc:spawn:reply:request-2";
		events.emit("subagents:rpc:spawn", { requestId: "request-2" });
		assert.equal(events.listenerCount(pendingReplyChannel), 1);
		await lifecycleHandlers.get("session_shutdown")();
		assert.equal(events.listenerCount(pendingReplyChannel), 0);
		assert.equal(events.listenerCount("subagents:rpc:spawn"), 0);
	});
});
