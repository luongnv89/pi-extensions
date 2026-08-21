#!/usr/bin/env node
// Packaging consistency guard: every `pi.extensions` entry must be shipped by
// the npm package, i.e. covered by the `files` allowlist in package.json.
//
// Semantics mirrored from npm:
// - no `files` field => everything is published => pass
// - directory entries cover everything under them
// - entries prefixed with `!` are exclusions and override earlier matches
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const extensionsDir = join(root, "extensions");

function collectViolations(pkgDir) {
	const pkgPath = join(pkgDir, "package.json");
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	const entries = pkg.pi?.extensions ?? [];
	if (entries.length === 0) return [];

	const rawFiles = pkg.files;
	if (!Array.isArray(rawFiles)) return []; // no allowlist: npm ships everything

	// Last matching entry wins (npm applies rules in order).
	const rules = rawFiles.map((f) => ({
		pattern: f.replace(/^\.\//, "").replace(/\/$/, ""),
		exclude: f.startsWith("!"),
	}));

	const violations = [];
	for (const entry of entries) {
		const rel = entry.replace(/^\.\//, "");
		let covered = false;
		for (const { pattern, exclude } of rules) {
			const matches =
				pattern === rel || rel.startsWith(pattern ? `${pattern}/` : "\u0000");
			if (matches) covered = !exclude;
		}
		if (!covered) violations.push(entry);
	}
	return violations;
}

const failures = [];
for (const name of readdirSync(extensionsDir).sort()) {
	const dir = join(extensionsDir, name);
	if (!statSync(dir).isDirectory()) continue;
	for (const entry of collectViolations(dir)) {
		failures.push({ pkg: name, entry });
	}
}

if (failures.length > 0) {
	console.error("Packaging check FAILED — pi.extensions entries not shipped:");
	for (const { pkg, entry } of failures) {
		console.error(`  extensions/${pkg}: ${entry} is not covered by "files"`);
	}
	console.error(
		"\nFix: add the missing paths to \"files\" in the package.json, or point pi.extensions at shipped files.",
	);
	process.exit(1);
}

console.log("Packaging check OK: all pi.extensions entries are shipped.");
