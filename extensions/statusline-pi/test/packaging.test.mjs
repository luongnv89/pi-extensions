import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const guardScript = fileURLToPath(
	new URL("../../../scripts/check-packaging.mjs", import.meta.url),
);

function isCoveredByFiles(entry, files) {
	const rel = entry.replace(/^\.\//, "");
	let covered = false;
	for (const raw of files) {
		const exclude = raw.startsWith("!");
		const pattern = raw.replace(/^\.\//, "").replace(/\/$/, "");
		if (pattern === rel || rel.startsWith(`${pattern}/`)) covered = !exclude;
	}
	return covered;
}

describe("npm packaging consistency (#32)", () => {
	it("ships every pi.extensions entry listed in files", () => {
		const entries = pkg.pi?.extensions ?? [];
		assert.ok(entries.length > 0, "pi.extensions must not be empty");
		for (const entry of entries) {
			assert.ok(
				isCoveredByFiles(entry, pkg.files ?? []),
				`${entry} is not covered by "files" ${JSON.stringify(pkg.files)}; the published tarball would miss it`,
			);
		}
	});

	it("passes the repo-wide packaging guard for all extensions", () => {
		execFileSync(process.execPath, [guardScript], { stdio: "pipe" });
	});
});
