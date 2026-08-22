import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import nineRouterPi, { normalizeBaseUrl, normalizeModels } from "./index.js";

test("normalizeBaseUrl trims configuration and trailing slashes", () => {
	assert.equal(normalizeBaseUrl(" http://localhost:20128/v1/// "), "http://localhost:20128/v1");
	assert.equal(normalizeBaseUrl(""), "http://localhost:20128/v1");
});

test("registration inherits the models.json API key when no environment key is set", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "9router-pi-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalApiKey = process.env.NINE_ROUTER_API_KEY;
	const originalBaseUrl = process.env.PI_9ROUTER_BASE_URL;
	const originalOffline = process.env.PI_OFFLINE;
	const originalFetch = globalThis.fetch;
	const requestedUrls: string[] = [];
	let providerConfig: Parameters<ExtensionAPI["registerProvider"]>[1] | undefined;

	try {
		await writeFile(
			join(agentDir, "models.json"),
			`{
				// Keep comments and trailing commas compatible with models.json.
				"providers": {
					"9router": {
						"baseUrl": "http://config.example/v1",
						"apiKey": "$TEST_9ROUTER_KEY",
					},
				},
			}`,
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		delete process.env.NINE_ROUTER_API_KEY;
		delete process.env.PI_9ROUTER_BASE_URL;
		delete process.env.PI_OFFLINE;
		globalThis.fetch = async (input) => {
			requestedUrls.push(String(input));
			return new Response(JSON.stringify({ data: [{ id: "discovered-model" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const pi = {
			registerCommand() {},
			registerProvider(_providerId: string, config: Parameters<ExtensionAPI["registerProvider"]>[1]) {
				if (!config.apiKey) throw new Error("dynamic provider registration requires an API key");
				providerConfig = config;
			},
		} as unknown as ExtensionAPI;

		await nineRouterPi(pi);
		assert.equal(providerConfig?.apiKey, "$TEST_9ROUTER_KEY");
		assert.equal(providerConfig?.baseUrl, "http://config.example/v1");
		assert.deepEqual(requestedUrls, ["http://config.example/v1/models"]);
		assert.equal(providerConfig?.models?.[0]?.id, "discovered-model");
	} finally {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		if (originalApiKey === undefined) delete process.env.NINE_ROUTER_API_KEY;
		else process.env.NINE_ROUTER_API_KEY = originalApiKey;
		if (originalBaseUrl === undefined) delete process.env.PI_9ROUTER_BASE_URL;
		else process.env.PI_9ROUTER_BASE_URL = originalBaseUrl;
		if (originalOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = originalOffline;
		globalThis.fetch = originalFetch;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("environment base URL overrides models.json for discovery and refresh", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "9router-pi-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalBaseUrl = process.env.PI_9ROUTER_BASE_URL;
	const originalOffline = process.env.PI_OFFLINE;
	const originalFetch = globalThis.fetch;
	const requestedUrls: string[] = [];
	let providerConfig: Parameters<ExtensionAPI["registerProvider"]>[1] | undefined;

	try {
		await writeFile(
			join(agentDir, "models.json"),
			JSON.stringify({ providers: { "9router": { baseUrl: "http://config.example/v1" } } }),
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_9ROUTER_BASE_URL = " http://environment.example/v1/// ";
		delete process.env.PI_OFFLINE;
		globalThis.fetch = async (input) => {
			requestedUrls.push(String(input));
			const id = requestedUrls.length === 1 ? "startup-model" : "refreshed-model";
			return new Response(JSON.stringify({ data: [{ id }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const pi = {
			registerCommand() {},
			registerProvider(_providerId: string, config: Parameters<ExtensionAPI["registerProvider"]>[1]) {
				providerConfig = config;
			},
		} as unknown as ExtensionAPI;

		await nineRouterPi(pi);
		assert.equal(providerConfig?.baseUrl, "http://environment.example/v1");
		assert.deepEqual(requestedUrls, ["http://environment.example/v1/models"]);
		assert.ok(providerConfig?.refreshModels);
		const refreshed = await providerConfig.refreshModels({
			allowNetwork: true,
			publish: async () => true,
			signal: new AbortController().signal,
		});
		assert.equal(refreshed[0]?.id, "refreshed-model");
		assert.deepEqual(requestedUrls, [
			"http://environment.example/v1/models",
			"http://environment.example/v1/models",
		]);
	} finally {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		if (originalBaseUrl === undefined) delete process.env.PI_9ROUTER_BASE_URL;
		else process.env.PI_9ROUTER_BASE_URL = originalBaseUrl;
		if (originalOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = originalOffline;
		globalThis.fetch = originalFetch;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("normalizeModels maps capabilities and removes invalid duplicates", () => {
	const models = normalizeModels({
		data: [
			{
				id: "alpha",
				context_length: 256000,
				max_completion_tokens: 8192,
				capabilities: {
					vision: true,
					reasoning: true,
					thinkingFormat: "zai",
					thinkingCanDisable: false,
				},
			},
			{ id: "alpha", capabilities: { reasoning: false } },
			{ id: "  beta  " },
			{ id: "" },
			{ id: null },
		],
	});

	assert.equal(models.length, 2);
	assert.deepEqual(models[0], {
		id: "alpha",
		name: "alpha",
		reasoning: true,
		thinkingLevelMap: { off: null },
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256000,
		maxTokens: 8192,
		compat: { thinkingFormat: "zai" },
	});
	assert.equal(models[1].id, "beta");
	assert.equal(models[1].contextWindow, 128000);
	assert.equal(models[1].maxTokens, 16384);
});

test("models.json quoted values keep comma-delimiter sequences intact", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "9router-pi-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalApiKey = process.env.NINE_ROUTER_API_KEY;
	const originalBaseUrl = process.env.PI_9ROUTER_BASE_URL;
	const originalOffline = process.env.PI_OFFLINE;
	const originalFetch = globalThis.fetch;
	let providerConfig: Parameters<ExtensionAPI["registerProvider"]>[1] | undefined;

	try {
		await writeFile(
			join(agentDir, "models.json"),
			`{
				"providers": {
					"9router": {
						"baseUrl": "http://config.example/v1, ]",
						"apiKey": "test-key, }",
					},
				},
			}`,
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		delete process.env.NINE_ROUTER_API_KEY;
		delete process.env.PI_9ROUTER_BASE_URL;
		delete process.env.PI_OFFLINE;
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ data: [{ id: "quoted-value-model" }] }), { status: 200 });

		const pi = {
			registerCommand() {},
			registerProvider(_providerId: string, config: Parameters<ExtensionAPI["registerProvider"]>[1]) {
				providerConfig = config;
			},
		} as unknown as ExtensionAPI;

		await nineRouterPi(pi);
		assert.equal(providerConfig?.baseUrl, "http://config.example/v1, ]");
		assert.equal(providerConfig?.apiKey, "test-key, }");
	} finally {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		if (originalApiKey === undefined) delete process.env.NINE_ROUTER_API_KEY;
		else process.env.NINE_ROUTER_API_KEY = originalApiKey;
		if (originalBaseUrl === undefined) delete process.env.PI_9ROUTER_BASE_URL;
		else process.env.PI_9ROUTER_BASE_URL = originalBaseUrl;
		if (originalOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = originalOffline;
		globalThis.fetch = originalFetch;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("offline startup registers an environment override overlay without models", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "9router-pi-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalApiKey = process.env.NINE_ROUTER_API_KEY;
	const originalBaseUrl = process.env.PI_9ROUTER_BASE_URL;
	const originalOffline = process.env.PI_OFFLINE;
	const originalFetch = globalThis.fetch;
	let providerConfig: Parameters<ExtensionAPI["registerProvider"]>[1] | undefined;
	let fetchCalls = 0;

	try {
		await writeFile(
			join(agentDir, "models.json"),
			JSON.stringify({ providers: { "9router": { baseUrl: "http://config.example/v1", apiKey: "config-key" } } }),
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_9ROUTER_BASE_URL = " http://environment.example/v1/// ";
		process.env.NINE_ROUTER_API_KEY = "environment-key";
		process.env.PI_OFFLINE = "1";
		globalThis.fetch = async () => {
			fetchCalls += 1;
			throw new Error("offline discovery should not run");
		};

		const pi = {
			registerCommand() {},
			registerProvider(_providerId: string, config: Parameters<ExtensionAPI["registerProvider"]>[1]) {
				providerConfig = config;
			},
		} as unknown as ExtensionAPI;

		await nineRouterPi(pi);
		assert.equal(fetchCalls, 0);
		assert.equal(providerConfig?.baseUrl, "http://environment.example/v1");
		assert.equal(providerConfig?.apiKey, "environment-key");
		assert.equal("models" in (providerConfig ?? {}), false);
	} finally {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		if (originalApiKey === undefined) delete process.env.NINE_ROUTER_API_KEY;
		else process.env.NINE_ROUTER_API_KEY = originalApiKey;
		if (originalBaseUrl === undefined) delete process.env.PI_9ROUTER_BASE_URL;
		else process.env.PI_9ROUTER_BASE_URL = originalBaseUrl;
		if (originalOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = originalOffline;
		globalThis.fetch = originalFetch;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("startup discovery failure registers an environment override overlay without models", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "9router-pi-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalApiKey = process.env.NINE_ROUTER_API_KEY;
	const originalBaseUrl = process.env.PI_9ROUTER_BASE_URL;
	const originalOffline = process.env.PI_OFFLINE;
	const originalFetch = globalThis.fetch;
	const requestedUrls: string[] = [];
	let providerConfig: Parameters<ExtensionAPI["registerProvider"]>[1] | undefined;

	try {
		await writeFile(
			join(agentDir, "models.json"),
			JSON.stringify({ providers: { "9router": { baseUrl: "http://config.example/v1", apiKey: "config-key" } } }),
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_9ROUTER_BASE_URL = "http://environment.example/v1";
		process.env.NINE_ROUTER_API_KEY = "environment-key";
		delete process.env.PI_OFFLINE;
		globalThis.fetch = async (input) => {
			requestedUrls.push(String(input));
			return new Response("unavailable", { status: 503 });
		};

		const pi = {
			registerCommand() {},
			registerProvider(_providerId: string, config: Parameters<ExtensionAPI["registerProvider"]>[1]) {
				providerConfig = config;
			},
		} as unknown as ExtensionAPI;

		await nineRouterPi(pi);
		assert.deepEqual(requestedUrls, ["http://environment.example/v1/models"]);
		assert.equal(providerConfig?.baseUrl, "http://environment.example/v1");
		assert.equal(providerConfig?.apiKey, "environment-key");
		assert.equal("models" in (providerConfig ?? {}), false);
	} finally {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		if (originalApiKey === undefined) delete process.env.NINE_ROUTER_API_KEY;
		else process.env.NINE_ROUTER_API_KEY = originalApiKey;
		if (originalBaseUrl === undefined) delete process.env.PI_9ROUTER_BASE_URL;
		else process.env.PI_9ROUTER_BASE_URL = originalBaseUrl;
		if (originalOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = originalOffline;
		globalThis.fetch = originalFetch;
		await rm(agentDir, { recursive: true, force: true });
	}
});
