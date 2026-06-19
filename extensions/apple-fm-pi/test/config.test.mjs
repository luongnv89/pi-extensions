import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const { loadAppleFmConfig } = await import(
	`file://${join(extRoot, "src/config.ts")}`
);

test("loadAppleFmConfig defaults", () => {
	const cfg = loadAppleFmConfig({});
	assert.equal(cfg.fmPort, 1976);
	assert.equal(cfg.proxyPort, 1977);
	assert.equal(cfg.host, "127.0.0.1");
	assert.equal(cfg.baseUrl, "http://127.0.0.1:1976/v1");
	assert.equal(cfg.useProxy, false);
	assert.equal(cfg.fmBin, "fm");
	assert.equal(cfg.autoStart, true);
	assert.equal(cfg.contextWindow, 4096);
	assert.equal(cfg.maxTokens, 2048);
});

test("loadAppleFmConfig 128k context", () => {
	const cfg = loadAppleFmConfig({
		APPLE_FM_PI_CONTEXT_WINDOW: "131072",
		APPLE_FM_PI_MAX_TOKENS: "8192",
	});
	assert.equal(cfg.contextWindow, 131_072);
	assert.equal(cfg.maxTokens, 8192);
});

test("loadAppleFmConfig caps context at 131072", () => {
	const cfg = loadAppleFmConfig({ APPLE_FM_PI_CONTEXT_WINDOW: "999999" });
	assert.equal(cfg.contextWindow, 131_072);
});

test("loadAppleFmConfig auto start off", () => {
	const cfg = loadAppleFmConfig({ APPLE_FM_PI_AUTO_START: "false" });
	assert.equal(cfg.autoStart, false);
});