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
			return new Response(JSON.stringify({ data: [{ id: "discovered-model:free" }] }), {
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
		assert.equal(providerConfig?.models?.[0]?.id, "discovered-model:free");
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
			const id = requestedUrls.length === 1 ? "startup-model:free" : "refreshed-model:free";
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
		assert.equal(refreshed[0]?.id, "refreshed-model:free");
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
				id: "alpha:free",
				context_length: 256000,
				max_completion_tokens: 8192,
				capabilities: {
					vision: true,
					reasoning: true,
					thinkingFormat: "zai",
					thinkingCanDisable: false,
				},
			},
			{ id: "alpha:free", capabilities: { reasoning: false } },
			{ id: "  beta:free  " },
			{ id: "" },
			{ id: null },
		],
	});

	assert.equal(models.length, 2);
	assert.deepEqual(models[0], {
		id: "alpha:free",
		name: "alpha:free",
		reasoning: true,
		thinkingLevelMap: { off: null },
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256000,
		maxTokens: 8192,
		compat: { thinkingFormat: "zai" },
	});
	assert.equal(models[1].id, "beta:free");
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

test("startup fallback refresh retries discovery through the command", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "9router-pi-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalApiKey = process.env.NINE_ROUTER_API_KEY;
	const originalBaseUrl = process.env.PI_9ROUTER_BASE_URL;
	const originalOffline = process.env.PI_OFFLINE;
	const originalFetch = globalThis.fetch;
	const requestedUrls: string[] = [];
	let providerConfig: Parameters<ExtensionAPI["registerProvider"]>[1] | undefined;
	type CommandHandler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
	let commandHandler: CommandHandler | undefined;

	try {
		await writeFile(
			join(agentDir, "models.json"),
			JSON.stringify({ providers: { "9router": { apiKey: "config-key" } } }),
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_9ROUTER_BASE_URL = "http://environment.example/v1";
		delete process.env.PI_OFFLINE;
		globalThis.fetch = async (input) => {
			requestedUrls.push(String(input));
			if (requestedUrls.length === 1) return new Response("unavailable", { status: 503 });
			return new Response(JSON.stringify({ data: [{ id: "retried-model" }] }), { status: 200 });
		};

		const pi = {
			registerCommand(_name: string, config: { handler: CommandHandler }) {
				commandHandler = config.handler;
			},
			registerProvider(_providerId: string, config: Parameters<ExtensionAPI["registerProvider"]>[1]) {
				providerConfig = config;
			},
		} as unknown as ExtensionAPI;

		await nineRouterPi(pi);
		const fallbackConfig = providerConfig;
		const refresh = fallbackConfig?.refreshModels;
		assert.ok(refresh);
		assert.ok(commandHandler);
		const ctx = {
			modelRegistry: {
				refresh: async () => {
					const models = await refresh({
						allowNetwork: true,
						publish: async () => true,
						signal: new AbortController().signal,
					});
					assert.equal(models?.[0]?.id, "retried-model");
					return { aborted: false, errors: new Map() };
				},
			},
			ui: { notify() {} },
		} as unknown as Parameters<CommandHandler>[1];

		await commandHandler("refresh", ctx);
		assert.deepEqual(requestedUrls, [
			"http://environment.example/v1/models",
			"http://environment.example/v1/models",
		]);
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

test("fallback preserves model-specific base URLs without a provider override", async () => {
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
			JSON.stringify({
				providers: {
					"9router": {
						apiKey: "config-key",
						models: [{ id: "configured-model", baseUrl: "http://model.example/v1" }],
					},
				},
			}),
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		delete process.env.NINE_ROUTER_API_KEY;
		delete process.env.PI_9ROUTER_BASE_URL;
		process.env.PI_OFFLINE = "1";
		globalThis.fetch = async () => {
			throw new Error("offline discovery should not run");
		};

		const pi = {
			registerCommand() {},
			registerProvider(_providerId: string, config: Parameters<ExtensionAPI["registerProvider"]>[1]) {
				providerConfig = config;
			},
		} as unknown as ExtensionAPI;

		await nineRouterPi(pi);
		assert.ok(providerConfig);
		assert.equal("baseUrl" in providerConfig, false);
		assert.ok(providerConfig.refreshModels);

		const cached = await providerConfig.refreshModels({
			allowNetwork: false,
			publish: async () => true,
			signal: new AbortController().signal,
		});
		assert.equal(cached[0]?.id, "configured-model");
		assert.equal(cached[0]?.baseUrl, "http://model.example/v1");

		const abortedController = new AbortController();
		abortedController.abort();
		const aborted = await providerConfig.refreshModels({
			allowNetwork: true,
			publish: async () => true,
			signal: abortedController.signal,
		});
		assert.equal(aborted[0]?.id, "configured-model");
		assert.equal(aborted[0]?.baseUrl, "http://model.example/v1");
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

test("fallback discovery gives refreshed models an explicit URL without overriding static model URLs", async () => {
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
			JSON.stringify({
				providers: {
					"9router": {
						apiKey: "config-key",
						models: [{ id: "configured-model:free", baseUrl: "http://model.example/v1" }],
					},
				},
			}),
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		delete process.env.NINE_ROUTER_API_KEY;
		delete process.env.PI_9ROUTER_BASE_URL;
		delete process.env.PI_OFFLINE;
		globalThis.fetch = async (input) => {
			requestedUrls.push(String(input));
			if (requestedUrls.length === 1) return new Response("unavailable", { status: 503 });
			return new Response(
				JSON.stringify({ data: [{ id: "configured-model:free" }, { id: "new-model:free" }] }),
				{ status: 200 },
			);
		};

		const pi = {
			registerCommand() {},
			registerProvider(_providerId: string, config: Parameters<ExtensionAPI["registerProvider"]>[1]) {
				providerConfig = config;
			},
		} as unknown as ExtensionAPI;

		await nineRouterPi(pi);
		assert.ok(providerConfig?.refreshModels);
		const refreshed = await providerConfig.refreshModels({
			allowNetwork: true,
			publish: async () => true,
			signal: new AbortController().signal,
		});

		assert.deepEqual(requestedUrls, [
			"http://localhost:20128/v1/models",
			"http://localhost:20128/v1/models",
		]);
		assert.equal(refreshed[0]?.baseUrl, "http://model.example/v1");
		assert.equal(refreshed[1]?.baseUrl, "http://localhost:20128/v1");
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

test("fallback reconstruction preserves metadata and merges provider compat defaults", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "9router-pi-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalBaseUrl = process.env.PI_9ROUTER_BASE_URL;
	const originalOffline = process.env.PI_OFFLINE;
	const originalFetch = globalThis.fetch;
	let providerConfig: Parameters<ExtensionAPI["registerProvider"]>[1] | undefined;
	const storedModel = {
		id: "stored-model",
		name: "Stored model",
		reasoning: false,
		input: ["text"],
		cost: {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			tiers: [{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, inputTokensAbove: 1000 }],
		},
		contextWindow: 8192,
		maxTokens: 1024,
		samplingParams: { temperature: 0.2 },
		headers: { "x-model": "stored" },
		compat: { supportsDeveloperRole: false },
		futureMetadata: { preserved: true },
	};

	try {
		await writeFile(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"9router": {
						compat: { supportsDeveloperRole: true, supportsUsageInStreaming: false },
					},
				},
			}),
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		delete process.env.PI_9ROUTER_BASE_URL;
		process.env.PI_OFFLINE = "1";
		globalThis.fetch = async () => {
			throw new Error("offline discovery should not run");
		};

		const pi = {
			registerCommand() {},
			registerProvider(_providerId: string, config: Parameters<ExtensionAPI["registerProvider"]>[1]) {
				providerConfig = config;
			},
		} as unknown as ExtensionAPI;

		await nineRouterPi(pi);
		assert.ok(providerConfig?.refreshModels);
		const result = await providerConfig.refreshModels({
			allowNetwork: false,
			stored: { models: [storedModel] } as never,
			publish: async ({ update }) => {
				update?.();
				return true;
			},
			signal: new AbortController().signal,
		});
		assert.deepEqual(result[0], {
			...storedModel,
			compat: { supportsDeveloperRole: false, supportsUsageInStreaming: false },
		});
		assert.deepEqual(storedModel.compat, { supportsDeveloperRole: false });
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

test("discovered models inherit provider compat without replacing model compat", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "9router-pi-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalBaseUrl = process.env.PI_9ROUTER_BASE_URL;
	const originalOffline = process.env.PI_OFFLINE;
	const originalFetch = globalThis.fetch;
	let providerConfig: Parameters<ExtensionAPI["registerProvider"]>[1] | undefined;

	try {
		await writeFile(
			join(agentDir, "models.json"),
			JSON.stringify({ providers: { "9router": { compat: { supportsDeveloperRole: true } } } }),
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_9ROUTER_BASE_URL = "http://compat.example/v1";
		delete process.env.PI_OFFLINE;
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					data: [{ id: "discovered-model:free", capabilities: { thinkingFormat: "zai", reasoning: true } }],
				}),
				{ status: 200 },
			);

		const pi = {
			registerCommand() {},
			registerProvider(_providerId: string, config: Parameters<ExtensionAPI["registerProvider"]>[1]) {
				providerConfig = config;
			},
		} as unknown as ExtensionAPI;

		await nineRouterPi(pi);
		assert.deepEqual(providerConfig?.models?.[0]?.compat, {
			supportsDeveloperRole: true,
			thinkingFormat: "zai",
		});
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

test("normalizeModels filters free-only when enabled", () => {
	const models = normalizeModels(
		{
			data: [
				{ id: "free-model:free" },
				{ id: "paid-model" },
				{ id: "no-suffix-model" },
			],
		},
		{ freeOnly: true },
	);
	assert.equal(models.length, 1);
	assert.equal(models[0].id, "free-model:free");
});

test("normalizeModels includes all models when freeOnly is disabled", () => {
	const models = normalizeModels(
		{
			data: [
				{ id: "free-model:free" },
				{ id: "paid-model" },
				{ id: "no-suffix-model" },
			],
		},
		{ freeOnly: false },
	);
	assert.equal(models.length, 3);
});

test("normalizeModels defaults to freeOnly=true", () => {
	const models = normalizeModels({
		data: [
			{ id: "free-model:free" },
			{ id: "paid-model" },
		],
	});
	assert.equal(models.length, 1);
	assert.equal(models[0].id, "free-model:free");
});

test("discovery respects PI_9ROUTER_FREE_ONLY=0 to include paid models", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "9router-pi-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalFreeOnly = process.env.PI_9ROUTER_FREE_ONLY;
	const originalFetch = globalThis.fetch;
	let providerConfig: Parameters<ExtensionAPI["registerProvider"]>[1] | undefined;

	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_9ROUTER_FREE_ONLY = "0";
		delete process.env.PI_OFFLINE;
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					data: [{ id: "free-model:free" }, { id: "paid-model" }],
				}),
				{ status: 200 },
			);

		const pi = {
			registerCommand() {},
			registerProvider(_providerId: string, config: Parameters<ExtensionAPI["registerProvider"]>[1]) {
				providerConfig = config;
			},
		} as unknown as ExtensionAPI;

		await nineRouterPi(pi);
		assert.equal(providerConfig?.models?.length, 2);
		assert.equal(providerConfig?.models?.[0].id, "free-model:free");
		assert.equal(providerConfig?.models?.[1].id, "paid-model");
	} finally {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		if (originalFreeOnly === undefined) delete process.env.PI_9ROUTER_FREE_ONLY;
		else process.env.PI_9ROUTER_FREE_ONLY = originalFreeOnly;
		globalThis.fetch = originalFetch;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("superseded refresh cannot overwrite a later cache-only catalog", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "9router-pi-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalBaseUrl = process.env.PI_9ROUTER_BASE_URL;
	const originalOffline = process.env.PI_OFFLINE;
	const originalFetch = globalThis.fetch;
	let providerConfig: Parameters<ExtensionAPI["registerProvider"]>[1] | undefined;
	let resolveFetch: ((response: Response) => void) | undefined;
	const fetchResponse = new Promise<Response>((resolve) => {
		resolveFetch = resolve;
	});

	try {
		await writeFile(
			join(agentDir, "models.json"),
			JSON.stringify({ providers: { "9router": { models: [{ id: "prior-model" }] } } }),
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		delete process.env.PI_9ROUTER_BASE_URL;
		process.env.PI_OFFLINE = "1";
		globalThis.fetch = async () => fetchResponse;

		const pi = {
			registerCommand() {},
			registerProvider(_providerId: string, config: Parameters<ExtensionAPI["registerProvider"]>[1]) {
				providerConfig = config;
			},
		} as unknown as ExtensionAPI;
		await nineRouterPi(pi);
		assert.ok(providerConfig?.refreshModels);

		delete process.env.PI_OFFLINE;
		const lateRefresh = providerConfig.refreshModels({
			allowNetwork: true,
			publish: async () => false,
			signal: new AbortController().signal,
		});
		const cached = await providerConfig.refreshModels({
			allowNetwork: false,
			stored: { models: [{ id: "cached-model" }] } as never,
			publish: async ({ update }) => {
				update?.();
				return true;
			},
			signal: new AbortController().signal,
		});
		assert.equal(cached[0]?.id, "cached-model");

		resolveFetch?.(new Response(JSON.stringify({ data: [{ id: "late-model:free" }] }), { status: 200 }));
		const rejected = await lateRefresh;
		assert.equal(rejected[0]?.id, "prior-model");

		const current = await providerConfig.refreshModels({
			allowNetwork: false,
			publish: async () => {
				throw new Error("no publication should be needed for an accepted cache");
			},
			signal: new AbortController().signal,
		});
		assert.equal(current[0]?.id, "cached-model");
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

test("bare /9router-pi opens a read-only TUI panel without side effects", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "9router-pi-panel-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalApiKey = process.env.NINE_ROUTER_API_KEY;
	const originalBaseUrl = process.env.PI_9ROUTER_BASE_URL;
	const originalOffline = process.env.PI_OFFLINE;
	const originalFetch = globalThis.fetch;
	const environmentSecret = "sk-ABC123";
	const modelsJsonSecret = "ordinary-looking-model-secret";
	const adversarialUrl = "https://user:password@example.invalid/private?token=raw-secret";
	const adversarialEmail = "person@example.invalid";
	const userPathModelId = "opencode/alice.smith";
	const adversarialJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature";
	const adversarialAnsi = "\u001b[31mansi-secret\u001b[0m";
	let commandHandler: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"] | undefined;
	let providerRegistrations = 0;
	let fetchCalls = 0;
	let refreshCalls = 0;
	let authCalls = 0;
	let availableCalls = 0;
	let modelCalls = 0;

	try {
		await writeFile(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"9router": {
						baseUrl: adversarialUrl,
						apiKey: modelsJsonSecret,
						models: [
							{ id: "safe-panel-model" },
							{ id: environmentSecret },
							{ id: modelsJsonSecret },
							{ id: adversarialUrl },
							{ id: adversarialEmail },
							{ id: userPathModelId },
							{ id: adversarialJwt },
							{ id: adversarialAnsi },
							{ id: "credential-token-value" },
						],
					},
				},
			}),
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.NINE_ROUTER_API_KEY = environmentSecret;
		process.env.PI_9ROUTER_BASE_URL = adversarialUrl;
		process.env.PI_OFFLINE = "1";
		globalThis.fetch = async () => {
			fetchCalls += 1;
			throw new Error("offline discovery should not run");
		};

		const pi = {
			registerCommand(_name: string, config: { handler: typeof commandHandler }) {
				commandHandler = config.handler;
			},
			registerProvider() {
				providerRegistrations += 1;
			},
		} as unknown as ExtensionAPI;
		await nineRouterPi(pi);
		assert.ok(commandHandler);
		assert.equal(providerRegistrations, 1);
		assert.equal(fetchCalls, 0);

		const selections: { title: string; options: string[] }[] = [];
		const choices = [
			"Provider status",
			"Back",
			"Configuration (source presence)",
			"Back",
			"Models (registered/available)",
			"Back",
			"Help / navigation",
			"Back",
			"Close",
		];
		const modelRegistry = {
			getProviderAuthStatus: () => {
				authCalls += 1;
				return { configured: true, source: "fallback", label: environmentSecret };
			},
			getAvailable: () => {
				availableCalls += 1;
				return [
					{ provider: "9router", id: "registry-safe-looking-model" },
					{ provider: "9router", id: environmentSecret },
					{ provider: "9router", id: modelsJsonSecret },
					{ provider: "9router", id: adversarialUrl },
					{ provider: "9router", id: adversarialEmail },
					{ provider: "9router", id: userPathModelId },
					{ provider: "9router", id: adversarialJwt },
					{ provider: "9router", id: adversarialAnsi },
					{ provider: "other-provider", id: "registry-other-provider-secret" },
				];
			},
			find: () => {
				modelCalls += 1;
				return undefined;
			},
			complete: async () => {
				modelCalls += 1;
				return undefined;
			},
			refresh: async () => {
				refreshCalls += 1;
				return { errors: new Map() };
			},
		} as never;
		const context = {
			mode: "tui",
			hasUI: true,
			modelRegistry,
			ui: {
				select: async (title: string, options: string[]) => {
					selections.push({ title, options });
					return choices.shift();
				},
				notify() {
					throw new Error("the read-only panel must not notify");
				},
			},
		} as never;

		await commandHandler("", context);
		assert.equal(selections.length, 9);
		assert.equal(choices.length, 0);
		assert.deepEqual(selections[0]?.options, [
			"Provider status",
			"Configuration (source presence)",
			"Models (registered/available)",
			"Help / navigation",
			"Close",
		]);
		const panelText = JSON.stringify(selections);
		assert.equal(panelText.includes(environmentSecret), false);
		assert.equal(panelText.includes(modelsJsonSecret), false);
		assert.equal(panelText.includes(adversarialUrl), false);
		assert.equal(panelText.includes(adversarialEmail), false);
		assert.equal(panelText.includes(userPathModelId), false);
		assert.equal(panelText.includes(adversarialJwt), false);
		assert.equal(panelText.includes(adversarialAnsi), false);
		assert.equal(panelText.includes("safe-panel-model"), false);
		assert.match(panelText, /Registered models: \d+/);
		assert.match(panelText, /Authentication source: environment/);
		assert.match(panelText, /Registry availability: 8 model\(s\)/);
		assert.equal(panelText.includes("registry-safe-looking-model"), false);
		assert.equal(panelText.includes("registry-other-provider-secret"), false);
		assert.equal(providerRegistrations, 1);
		assert.equal(fetchCalls, 0);
		assert.equal(refreshCalls, 0);
		assert.equal(authCalls, 1);
		assert.equal(availableCalls, 1);
		assert.equal(modelCalls, 0);

		let detailCancelledSelects = 0;
		const detailCancellationChoices: (string | undefined)[] = ["Provider status", undefined];
		await commandHandler("", {
			mode: "tui",
			hasUI: true,
			ui: {
				select: async () => {
					detailCancelledSelects += 1;
					return detailCancellationChoices.shift();
				},
				notify() {
					throw new Error("cancelling the detail must not notify");
				},
			},
			modelRegistry,
		} as never);
		assert.equal(detailCancelledSelects, 2);

		let cancelledSelects = 0;
		await commandHandler("", {
			mode: "tui",
			hasUI: true,
			ui: {
				select: async () => {
					cancelledSelects += 1;
					return undefined;
				},
				notify() {
					throw new Error("cancelling the panel must not notify");
				},
			},
			modelRegistry,
		} as never);
		assert.equal(cancelledSelects, 1);

		let nonTuiSelects = 0;
		const nonTuiNotifications: string[] = [];
		await commandHandler("", {
			mode: "print",
			hasUI: false,
			ui: {
				select: async () => {
					nonTuiSelects += 1;
					throw new Error("non-TUI bare command must not open the panel");
				},
				notify: (message: string) => nonTuiNotifications.push(message),
			},
			modelRegistry,
		} as never);
		assert.equal(nonTuiSelects, 0);
		assert.equal(nonTuiNotifications.length, 1);

		let explicitSelects = 0;
		const explicitNotifications: string[] = [];
		await commandHandler("help", {
			mode: "tui",
			hasUI: true,
			ui: {
				select: async () => {
					explicitSelects += 1;
					throw new Error("explicit subcommands must not open the panel");
				},
				notify: (message: string) => explicitNotifications.push(message),
			},
			modelRegistry,
		} as never);
		assert.equal(explicitSelects, 0);
		assert.deepEqual(explicitNotifications, ["Usage: /9router-pi [status|refresh|help]"]);
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
