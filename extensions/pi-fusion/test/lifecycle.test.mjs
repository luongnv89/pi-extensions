import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSidekickLifecycle, registerTreeNavigationHandler } from "../dist/index.js";

describe("sidekick branch lifecycle", () => {
	it("drops the sidekick before restoring state after tree navigation", async () => {
		const handlers = new Map();
		const calls = [];
		const handle = {
			key: "provider/model:coding:high",
			session: { dispose: () => calls.push("drop") },
		};
		const sidekick = createSidekickLifecycle(handle);
		const pi = {
			on(event, handler) {
				handlers.set(event, handler);
			},
		};

		registerTreeNavigationHandler(pi, sidekick, () => calls.push("restore"));

		assert.equal(sidekick.current, handle, "same-branch context remains reusable");
		assert.deepEqual(calls, []);
		await handlers.get("session_tree")({}, {});
		assert.equal(sidekick.current, undefined);
		assert.deepEqual(calls, ["drop", "restore"]);
	});
});
