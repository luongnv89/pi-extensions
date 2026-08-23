import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const {
	grokAuthGuidance,
	grokAuthPathIn,
	grokHarnessStateIn,
	grokInstallGuidance,
	grokReadinessLabel,
} = await import(`file://${join(extRoot, "src/harness.ts")}`);

function tempGrokHome() {
	return mkdtempSync(join(tmpdir(), "grok-pi-harness-"));
}

test("grokHarnessStateIn reports nothing installed in an empty home", () => {
	const grokHome = tempGrokHome();
	try {
		assert.deepEqual(grokHarnessStateIn(grokHome), {
			installed: false,
			authPresent: false,
		});
		assert.equal(grokReadinessLabel(grokHarnessStateIn(grokHome)), "no (install Grok CLI)");
	} finally {
		rmSync(grokHome, { recursive: true, force: true });
	}
});

test("grokHarnessStateIn reports ready when auth.json exists", () => {
	const grokHome = tempGrokHome();
	try {
		writeFileSync(grokAuthPathIn(grokHome), "{}", "utf8");
		const state = grokHarnessStateIn(grokHome);
		assert.deepEqual(state, { installed: true, authPresent: true });
		assert.equal(grokReadinessLabel(state), "yes");
	} finally {
		rmSync(grokHome, { recursive: true, force: true });
	}
});

test("grokHarnessStateIn distinguishes a CLI install without login", () => {
	const grokHome = tempGrokHome();
	try {
		mkdirSync(join(grokHome, "bin"), { recursive: true });
		writeFileSync(join(grokHome, "bin", "grok"), "#!/bin/sh\n", "utf8");
		const state = grokHarnessStateIn(grokHome);
		assert.deepEqual(state, { installed: true, authPresent: false });
		assert.equal(grokReadinessLabel(state), "no (run `grok login`)");
	} finally {
		rmSync(grokHome, { recursive: true, force: true });
	}
});

test("install guidance names the Grok CLI and the install URL", () => {
	const guidance = grokInstallGuidance();
	assert.match(guidance, /Grok CLI not found/);
	assert.match(guidance, /https:\/\/x\.ai\/grok/);
	assert.match(guidance, /`grok login`/);
});

test("auth guidance distinguishes a missing login from a missing install", () => {
	const guidance = grokAuthGuidance();
	assert.match(guidance, /installed but ~/);
	assert.match(guidance, /~\/.grok\/auth\.json is missing/);
	assert.match(guidance, /`grok login`/);
});
