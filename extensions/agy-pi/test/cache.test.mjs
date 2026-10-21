import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const {
	BUNDLED_MODELS,
	cacheFilePath,
	cacheReadError,
	pendingCatalog,
	readModelCache,
	writeModelCache,
	default: agyPiExtension,
} = await import(`file://${join(extRoot, "src/index.ts")}`);

function tempCachePath(label) {
	const dir = mkdtempSync(join(tmpdir(), `agy-pi-cache-${label}-`));
	return join(dir, "models.json");
}

function restoreEnv(key, value) {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

/** Run with a dedicated temp cache path and no AGY_PI_MODELS override. */
function withTempCache(run) {
	const path = tempCachePath();
	const previousCache = process.env.AGY_PI_CACHE;
	const previousModels = process.env.AGY_PI_MODELS;
	const previousBin = process.env.AGY_PI_BIN;
	process.env.AGY_PI_CACHE = path;
	delete process.env.AGY_PI_MODELS;
	// Default every background probe to a missing binary so a lingering
	// fire-and-forget probe cannot outlive a test and write into the NEXT
	// test's cache path; withFakeAgyAndCache replaces this afterwards.
	process.env.AGY_PI_BIN = join(tmpdir(), `agy-pi-missing-bin-${Date.now()}`);
	return Promise.resolve()
		.then(run)
		.finally(() => {
			restoreEnv("AGY_PI_CACHE", previousCache);
			restoreEnv("AGY_PI_MODELS", previousModels);
			restoreEnv("AGY_PI_BIN", previousBin);
			rmSync(dirname(path), { recursive: true, force: true });
		});
}

function loadExtension() {
	const registrations = [];
	let command;
	agyPiExtension({
		registerProvider(_id, config) { registrations.push(config); },
		registerCommand(_name, config) { command = config; },
		on() {},
	});
	return { models: registrations[0]?.models, command };
}

function poll(predicate, timeoutMs = 3_000, stepMs = 25) {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve) => {
		const tick = () => {
			if (predicate() || Date.now() > deadline) resolve();
			else setTimeout(tick, stepMs);
		};
		tick();
	});
}

function validCatalogEntry(id, name = `Name ${id}`) {
	return {
		id,
		name,
		contextWindow: 123_456,
		maxTokens: 4_321,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function catalogPayload(catalog) {
	return JSON.stringify({ schema: 1, fetchedAt: "2026-01-01T00:00:00.000Z", catalog });
}

test("cacheFilePath honors AGY_PI_CACHE over the platform default", () => {
	const previous = process.env.AGY_PI_CACHE;
	try {
		process.env.AGY_PI_CACHE = "/tmp/override/models.json";
		assert.equal(cacheFilePath(), "/tmp/override/models.json");
		delete process.env.AGY_PI_CACHE;
		assert.match(cacheFilePath(), /agy-pi[\\/]models\.json$/);
	} finally {
		restoreEnv("AGY_PI_CACHE", previous);
	}
});

test("readModelCache accepts a valid cache payload", () => {
	const entry = validCatalogEntry("some-model-high");
	entry.effortLevels = ["high", "low"];
	const path = tempCachePath();
	writeFileSync(path, catalogPayload([entry]));
	const parsed = readModelCache(path);
	assert.deepEqual(parsed, [entry]);
	rmSync(dirname(path), { recursive: true, force: true });
});

test("corrupt and unrecognized cache files read as absent", () => {
	const path = tempCachePath();
	try {
		writeFileSync(path, "{not json");
		assert.equal(readModelCache(path), undefined);
		writeFileSync(path, JSON.stringify({ schema: 999, fetchedAt: "x", catalog: [] }));
		assert.equal(readModelCache(path), undefined);
		writeFileSync(path, catalogPayload([{ ...validCatalogEntry("bad"), contextWindow: "big" }]));
		assert.equal(readModelCache(path), undefined);
		writeFileSync(path, catalogPayload([validCatalogEntry("ok"), {}]));
		assert.equal(readModelCache(path), undefined);
		assert.equal(readModelCache(join(path, "does-not-exist.json")), undefined);
	} finally {
		rmSync(dirname(path), { recursive: true, force: true });
	}
});

test("writeModelCache writes atomically with schema, fetchedAt, and catalog", () => {
	const path = tempCachePath();
	try {
		assert.equal(writeModelCache([validCatalogEntry("m1")], path), true);
		assert.deepEqual(readModelCache(path), [validCatalogEntry("m1")]);
		const raw = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(raw.schema, 1);
		assert.ok(!Number.isNaN(Date.parse(raw.fetchedAt)));
		const siblings = readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp"));
		assert.deepEqual(siblings, [], "atomic rename must leave no temp files behind");
	} finally {
		rmSync(dirname(path), { recursive: true, force: true });
	}
});

test("writeModelCache replaces a corrupt cache file on the next successful write", () => {
	const path = tempCachePath();
	try {
		writeFileSync(path, "{corrupt");
		assert.equal(writeModelCache([validCatalogEntry("replacement")], path), true);
		assert.deepEqual(readModelCache(path), [validCatalogEntry("replacement")]);
	} finally {
		rmSync(dirname(path), { recursive: true, force: true });
	}
});

test("writeModelCache stays silent on failure and never rejects", () => {
	const dir = mkdtempSync(join(tmpdir(), "agy-pi-cache-blocked-"));
	try {
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "this is a file, not a directory");
		assert.equal(writeModelCache([validCatalogEntry("m1")], join(blocker, "models.json")), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a valid cache wins over the bundled catalog on load", async () => {
	await withTempCache(async () => {
		const path = cacheFilePath();
		const catalog = [validCatalogEntry("cache-only-family-low")]
		writeFileSync(path, catalogPayload(catalog));
		const { models } = loadExtension();
		assert.ok(models.length === 1);
		assert.equal(models[0].id, "cache-only-family-low");
		assert.ok(models[0].name.startsWith("Name cache-only-family-low"));
	});
});

test("a missing or corrupt cache falls back to the bundled catalog on load", async () => {
	for (const setup of [null, () => writeFileSync(cacheFilePath(), "{broken")]) {
		await withTempCache(async () => {
			if (setup) setup();
			const { models } = loadExtension();
			const bundledFamilies = new Set(
				[...new Set(BUNDLED_MODELS.map((m) => m.id))].map((id) => id.replace(/-(high|medium|low)$/, "")),
			);
			assert.equal(models.length, bundledFamilies.size);
			for (const model of models) assert.ok(bundledFamilies.has(model.id), `expected a bundled family, got ${model.id}`);
		});
	}
});

function chmod755(path) {
	chmodSync(path, 0o755);
}

/** Fake agy binary on PATH (AGY_PI_BIN) plus a dedicated temp cache path. */
function withFakeAgyAndCache(script, run) {
	return withTempCache(() => {
		const dir = mkdtempSync(join(tmpdir(), "agy-pi-fake-bin-"));
		const binPath = join(dir, "agy-fake.js");
		writeFileSync(binPath, `#!/usr/bin/env node\n${script}`, "utf8");
		chmod755(binPath);
		const previousBin = process.env.AGY_PI_BIN;
		process.env.AGY_PI_BIN = binPath;
		return Promise.resolve()
			.then(run)
			.finally(() => {
				restoreEnv("AGY_PI_BIN", previousBin);
				rmSync(dir, { recursive: true, force: true });
			});
	});
}

test("a successful probe atomically writes the cache and updates in-memory state", async () => {
	await withFakeAgyAndCache(
		`process.stdout.write("cache-made-model\\tCache Made Model (High)\\n");`,
		async () => {
			const { models, command } = loadExtension();
			const path = cacheFilePath();
			// Explicit update probe (same cache-write path as the background refresh).
			await command.handler("update", { ui: { notify() {} } });
			assert.ok(existsSync(path), "successful probe must write the cache file");
			const seen = [];
			await command.handler("models", { ui: { notify(msg) { seen.push(msg); } } });
			assert.ok(seen.includes("agy/cache-made-model"), "in-memory state mirrors the refreshed catalog");
			const raw = JSON.parse(readFileSync(path, "utf8"));
			assert.equal(raw.schema, 1);
			assert.ok(!Number.isNaN(Date.parse(raw.fetchedAt)));
			assert.deepEqual(
				raw.catalog.map((entry) => entry.id),
				["cache-made-model"],
			);
			const siblings = readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp"));
			assert.deepEqual(siblings, [], "cache write must be atomic (no temp leftovers)");
		},
	);
});

test("a failed probe writes nothing to the cache", async () => {
	await withFakeAgyAndCache(
		`process.stderr.write("not authenticated\\n"); process.exit(4);`,
		async () => {
			const { command } = loadExtension();
			await command.handler("update", { ui: { notify() {} } });
			assert.equal(existsSync(cacheFilePath()), false, "failed probe must not write the cache");
		},
	);
	await withTempCache(() => {
		const previousBin = process.env.AGY_PI_BIN;
		process.env.AGY_PI_BIN = join(tmpdir(), `agy-pi-missing-${Date.now()}`);
		return Promise.resolve()
			.then(loadExtension)
			.then(async () => {
				await poll(() => false, 150); // give the fire-and-forget probe time to fail
				assert.equal(existsSync(cacheFilePath()), false);
			})
			.finally(() => restoreEnv("AGY_PI_BIN", previousBin));
	});
});

test("the fire-and-forget probe writes the cache and updates state for the next load", async () => {
	await withFakeAgyAndCache(
		`process.stdout.write("background-model\\tBackground Model\\n");`,
		async () => {
			const { models } = loadExtension();
			const bundledFamilies = new Set(
				[...new Set(BUNDLED_MODELS.map((m) => m.id))].map((id) => id.replace(/-(high|medium|low)$/, "")),
			);
			for (const model of models) assert.ok(bundledFamilies.has(model.id), `bundled family expected, got ${model.id}`);
			await poll(() => existsSync(cacheFilePath()));
			assert.ok(existsSync(cacheFilePath()), "background probe must write the cache");
			assert.ok(!readdirSync(dirname(cacheFilePath())).some((name) => name.endsWith(".tmp")));
			// The registration snapshot for this session stays bundled; the
			// refreshed catalog applies on the next load only.
			const registered = readModelCache(cacheFilePath());
			assert.ok(registered.some((entry) => entry.id === "background-model"));
		},
	);
});

test("writeModelCache refuses to persist banner-like ids", async () => {
	const path = tempCachePath();
	try {
		// A CLI banner or parse drift must never become a durable catalog.
		const bannerModels = ["Welcome to agy v2.1!", "Rendering table data...", "the whiteboard columns."].map(
			(id) => validCatalogEntry(id),
		);
		assert.equal(writeModelCache(bannerModels, path), false);
		assert.equal(existsSync(path), false);
		const rawModels = [
			...bannerModels,
			validCatalogEntry("good-model"),
		];
		assert.equal(writeModelCache(rawModels, path), true, "plausible ids must still be written");
		assert.deepEqual(readModelCache(path).map((m) => m.id), ["good-model"]);
	} finally {
		rmSync(dirname(path), { recursive: true, force: true });
	}
});

test("readModelCache distinguishes absence from unreadable paths without throwing", () => {
	const dir = mkdtempSync(join(tmpdir(), "agy-pi-cache-unreadable-"));
	try {
		assert.equal(cacheReadError(), undefined);
		readModelCache(join(dir, "absent.json"));
		assert.equal(cacheReadError(), undefined, "absent file is not an error");
		const asDirectory = join(dir, "as-dir");
		mkdirSync(asDirectory);
		readModelCache(asDirectory);
		assert.match(String(cacheReadError()), /cache unreadable/, "unreadable path must be surfaced via cacheReadError()");
	} finally {
		lastCacheReadErrorReset(dir);
	}
});

function lastCacheReadErrorReset(dir) {
	readModelCache(join(dir, "reset-after-dir.json"));
	rmSync(dir, { recursive: true, force: true });
}

test("a fresh cache skips the background probe (cooldown)", async () => {
	await withFakeAgyAndCache(
		`process.stdout.write("cooldown-model\tCooldown Model\n");`,
		async () => {
			const path = cacheFilePath();
			// Write a fresh cache BEFORE the extension loads, so the background
			// probe sees it within the cooldown window and must not run.
			writeFileSync(path, catalogPayload([validCatalogEntry("pre-cooldown-model")]));
			const { models } = loadExtension();
			await poll(() => false, 150);
			const raw = JSON.parse(readFileSync(path, "utf8"));
			assert.deepEqual(
				raw.catalog.map((entry) => entry.id),
				["pre-cooldown-model"],
				"a fresh cache must not be overwritten by a redundant probe",
			);
			assert.equal(models.length > 0, true);
		},
	);
});
