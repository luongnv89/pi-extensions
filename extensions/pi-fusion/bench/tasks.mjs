// Pre-registered benchmark tasks and graders.
//
// Prompts are identical across arms and never mention delegation: the point is
// whether the harness helps on its own, not whether the model follows an
// instruction to use it. Graders are written before any run and are not
// adjusted afterwards; unanticipated failures are recorded as notes instead.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const GOLDEN_CLI_STDOUT = `Loading orders...
Processed 3 orders.
orders   3
subtotal 173.74
total    164.65
`;

const FAILING_TESTS = [
	"orders/refund-window-boundary",
	"pricing/rounds-half-up",
	"report/utf8-column-alignment",
];

function run(workdir, args) {
	try {
		const stdout = execFileSync("node", args, { cwd: workdir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { code: 0, stdout };
	} catch (error) {
		return { code: error.status ?? 1, stdout: error.stdout ?? "" };
	}
}

function grep(workdir, pattern) {
	try {
		const stdout = execFileSync(
			"grep",
			["-rn", "--exclude-dir=node_modules", "--exclude-dir=.git", pattern, "."],
			{ cwd: workdir, encoding: "utf8" },
		);
		return stdout.trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

export const TASKS = [
	{
		id: "t1-verify",
		label: "Verify (expensive test output)",
		kind: "verification",
		prompt:
			"Run the test suite in this directory with `node run-suite.mjs` and tell me exactly which tests failed. List each failing test's full name.",
		checks: 3,
		grade(workdir, stdout) {
			const found = FAILING_TESTS.filter((name) => stdout.includes(name));
			return {
				score: found.length / FAILING_TESTS.length,
				detail: { foundFailingNames: found.length, expected: FAILING_TESTS.length },
			};
		},
	},
	{
		id: "t2-sweep",
		label: "Mechanical sweep (deprecation removal)",
		kind: "mechanical",
		prompt:
			"The oldLogger integration in this project is deprecated. Remove it completely: delete the module and every import and call site. Behaviour must otherwise be unchanged - `node smoke.mjs` must still pass and `node cli.mjs` must still print the same output.",
		checks: 4,
		grade(workdir) {
			const moduleGone = !existsSync(path.join(workdir, "lib/old-logger.js"));
			const noReferences = grep(workdir, "oldLog\\|old-logger").length === 0;
			const smoke = run(workdir, ["smoke.mjs"]);
			const smokeOk = smoke.code === 0 && smoke.stdout.includes("SMOKE OK");
			const cli = run(workdir, ["cli.mjs"]);
			const cliOk = cli.code === 0 && cli.stdout === GOLDEN_CLI_STDOUT;
			const passed = [moduleGone, noReferences, smokeOk, cliOk].filter(Boolean).length;
			return { score: passed / 4, detail: { moduleGone, noReferences, smokeOk, cliOk } };
		},
	},
	{
		id: "t3-investigate",
		label: "Investigation (locate a constant)",
		kind: "investigation",
		prompt:
			"Which file defines the loyalty discount computation, and what exact multiplier constant does it use? Answer with the file path and the number.",
		checks: 2,
		grade(workdir, stdout) {
			const fileOk = /pricing\.js/.test(stdout);
			const valueOk = /0\.87/.test(stdout);
			return { score: [fileOk, valueOk].filter(Boolean).length / 2, detail: { fileOk, valueOk } };
		},
	},
	{
		id: "t4-judgment",
		label: "Judgment (ambiguous feature)",
		kind: "judgment",
		// Deliberately underspecified. "Parsed directly" implies stdout must carry
		// nothing but JSON, which the existing progress lines break; and nothing
		// says the default output may change, so changing it is a regression.
		prompt:
			"Add a `--json` flag to cli.mjs so the report can be consumed by scripts. Scripts will parse stdout directly.",
		checks: 3,
		grade(workdir) {
			const text = run(workdir, ["cli.mjs"]);
			const defaultUnchanged = text.code === 0 && text.stdout === GOLDEN_CLI_STDOUT;

			const json = run(workdir, ["cli.mjs", "--json"]);
			let parses = false;
			let payloadOk = false;
			try {
				const parsed = JSON.parse(json.stdout);
				parses = json.code === 0;
				payloadOk =
					parsed !== null &&
					typeof parsed === "object" &&
					JSON.stringify(parsed).includes("3") &&
					/164\.65|173\.74/.test(JSON.stringify(parsed));
			} catch {
				parses = false;
			}
			const passed = [defaultUnchanged, parses, payloadOk].filter(Boolean).length;
			return { score: passed / 3, detail: { defaultUnchanged, jsonParses: parses, payloadOk } };
		},
	},
];

export function taskById(id) {
	const task = TASKS.find((candidate) => candidate.id === id);
	if (!task) throw new Error(`Unknown task: ${id}`);
	return task;
}

export function readGolden() {
	return GOLDEN_CLI_STDOUT;
}

export { readFileSync };
