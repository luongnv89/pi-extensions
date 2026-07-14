import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const packageJson = JSON.parse(
	await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

describe("package manifest", () => {
	it("ships the Pi source extension entry", () => {
		assert.deepEqual(packageJson.pi.extensions, ["./src/index.ts"]);
		assert.ok(packageJson.files.includes("src"));
	});
});
