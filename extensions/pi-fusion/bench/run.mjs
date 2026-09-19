#!/usr/bin/env node
// pi-fusion benchmark runner.
//
// Runs each task twice - once on plain pi (baseline), once with pi-fusion
// loaded - on a fresh copy of the fixture, then grades the result and reads
// real cost out of the session file. Both arms run with extension, skill, and
// context-file discovery disabled so the only difference is pi-fusion itself.

import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TASKS } from "./tasks.mjs";

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(BENCH_DIR, "fixture");
const EXTENSION = path.join(BENCH_DIR, "..", "src", "index.ts");
const RESULTS_DIR = path.join(BENCH_DIR, "results");

const options = parseArgs(process.argv.slice(2));

async function main() {
	mkdirSync(RESULTS_DIR, { recursive: true });
	const tasks = TASKS.filter((task) => options.tasks.length === 0 || options.tasks.includes(task.id));
	const runs = [];
	const total = tasks.length * options.arms.length * options.reps;
	let index = 0;

	console.log(
		`pi-fusion benchmark — ${tasks.length} tasks × ${options.arms.length} arms × ${options.reps} reps = ${total} sessions`,
	);
	console.log(`main: ${options.main} · sidekick: ${options.sidekick} · timeout ${options.timeoutMs}ms\n`);

	for (let rep = 1; rep <= options.reps; rep += 1) {
		for (const task of tasks) {
			// Arms are interleaved per task so provider-side drift hits both equally.
			for (const arm of options.arms) {
				index += 1;
				process.stdout.write(`[${index}/${total}] rep${rep} ${task.id} ${arm} ... `);
				const run = await runOne(task, arm, rep);
				runs.push(run);
				console.log(
					`score ${run.score.toFixed(2)} · $${run.totalCost.toFixed(4)} · ${run.delegations} deleg · ${(run.wallMs / 1000).toFixed(1)}s${run.error ? ` · ${run.error}` : ""}`,
				);
			}
		}
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outFile = path.join(RESULTS_DIR, `${stamp}.json`);
	const payload = { options, startedAt: stamp, runs };
	writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`);
	console.log(`\nRaw results: ${path.relative(process.cwd(), outFile)}\n`);
	console.log(renderReport(runs, tasks));
	writeFileSync(outFile.replace(/\.json$/, ".md"), `${renderReport(runs, tasks)}\n`);
}

async function runOne(task, arm, rep) {
	const workdir = mkdtempSync(path.join(os.tmpdir(), `pi-fusion-bench-${task.id}-${arm}-`));
	// Sessions live outside the work directory: a transcript quotes the code it
	// edited, so a session file inside the project makes any "no references remain"
	// grader match its own logs.
	const sessionDir = mkdtempSync(path.join(os.tmpdir(), `pi-fusion-bench-sessions-${task.id}-${arm}-`));
	cpSync(FIXTURE, workdir, { recursive: true });

	const args = [
		"-p",
		task.prompt,
		"--model",
		options.main,
		"--no-extensions",
		"--no-skills",
		"--no-context-files",
		"--session-dir",
		sessionDir,
	];
	if (arm === "fusion") {
		args.push(
			"-e",
			EXTENSION,
			"--fusion-sidekick",
			options.sidekick,
			"--fusion-tools",
			"coding",
			"--fusion-max-delegations",
			"10",
		);
	}

	const startedAt = Date.now();
	const { stdout, error } = await runPi(args, workdir);
	const wallMs = Date.now() - startedAt;

	let graded = { score: 0, detail: { graderError: true } };
	try {
		graded = task.grade(workdir, stdout);
	} catch (failure) {
		graded = { score: 0, detail: { graderError: String(failure?.message ?? failure) } };
	}

	const session = readSession(sessionDir);
	if (!options.keep) {
		rmSync(workdir, { recursive: true, force: true });
		rmSync(sessionDir, { recursive: true, force: true });
	}

	return {
		rep,
		task: task.id,
		kind: task.kind,
		arm,
		score: graded.score,
		detail: graded.detail,
		wallMs,
		error,
		mainCost: session.mainCost,
		sidekickCost: session.sidekickCost,
		totalCost: session.mainCost + session.sidekickCost,
		mainTokens: session.mainTokens,
		sidekickTokens: session.sidekickTokens,
		firstTurnInput: session.firstTurnInput,
		assistantTurns: session.assistantTurns,
		delegations: session.delegations,
		finalText: stdout.trim().slice(-1200),
	};
}

/**
 * stdin is closed explicitly: pi's print mode keeps reading an open stdin pipe
 * and never exits, which looks exactly like a model hang.
 */
function runPi(args, cwd) {
	return new Promise((resolve) => {
		const child = spawn("pi", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let error;
		const timer = setTimeout(() => {
			error = "timeout";
			child.kill("SIGKILL");
		}, options.timeoutMs);

		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (failure) => {
			error = `spawn: ${failure.message}`;
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (!error && code !== 0) error = `exit ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ""}`;
			resolve({ stdout, stderr, error });
		});
	});
}

/** Cost comes from the provider-recorded per-message totals, never recomputed. */
function readSession(sessionDir) {
	const empty = {
		mainCost: 0,
		sidekickCost: 0,
		mainTokens: 0,
		sidekickTokens: 0,
		firstTurnInput: 0,
		assistantTurns: 0,
		delegations: 0,
	};
	let files = [];
	try {
		files = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"));
	} catch {
		return empty;
	}
	const result = { ...empty };
	for (const file of files) {
		let lines = [];
		try {
			lines = readFileSync(path.join(sessionDir, file), "utf8").trim().split("\n").filter(Boolean);
		} catch {
			continue;
		}
		for (const line of lines) {
			let entry;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message?.role === "assistant" && message.usage) {
				result.mainCost += message.usage.cost?.total ?? 0;
				result.mainTokens += message.usage.totalTokens ?? 0;
				result.assistantTurns += 1;
				if (result.firstTurnInput === 0) result.firstTurnInput = message.usage.input ?? 0;
			}
			if (message?.role === "toolResult" && message.toolName === "delegate") {
				const fusion = message.details?.fusion;
				if (fusion) {
					result.delegations += 1;
					result.sidekickCost += fusion.cost ?? 0;
					result.sidekickTokens += fusion.tokens?.total ?? 0;
				}
			}
		}
	}
	return result;
}

function renderReport(runs, tasks) {
	const lines = [];
	lines.push("# pi-fusion benchmark");
	lines.push("");
	lines.push(`- main model: \`${options.main}\``);
	lines.push(`- sidekick model: \`${options.sidekick}\``);
	lines.push(`- reps per cell: ${options.reps}`);
	lines.push("- both arms: `--no-extensions --no-skills --no-context-files`");
	lines.push("- cost is the provider-recorded per-message total, summed; sidekick cost added from delegate results");
	lines.push("");
	lines.push("## Per task");
	lines.push("");
	lines.push("| Task | Arm | Score | Cost (mean) | Cost (min–max) | Tokens | Deleg | Wall |");
	lines.push("|---|---|---|---|---|---|---|---|");

	for (const task of tasks) {
		for (const arm of options.arms) {
			const cell = runs.filter((run) => run.task === task.id && run.arm === arm);
			if (cell.length === 0) continue;
			const costs = cell.map((run) => run.totalCost);
			lines.push(
				`| ${task.id} | ${arm} | ${pct(mean(cell.map((r) => r.score)))} | $${mean(costs).toFixed(4)} | $${Math.min(...costs).toFixed(4)}–$${Math.max(...costs).toFixed(4)} | ${Math.round(mean(cell.map((r) => r.mainTokens + r.sidekickTokens)))} | ${mean(cell.map((r) => r.delegations)).toFixed(1)} | ${(mean(cell.map((r) => r.wallMs)) / 1000).toFixed(1)}s |`,
			);
		}
	}

	lines.push("");
	lines.push("## Totals");
	lines.push("");
	lines.push("| Arm | Mean score | Total cost | Mean cost/task | Delegations |");
	lines.push("|---|---|---|---|---|");
	for (const arm of options.arms) {
		const cell = runs.filter((run) => run.arm === arm);
		if (cell.length === 0) continue;
		const costs = cell.map((run) => run.totalCost);
		lines.push(
			`| ${arm} | ${pct(mean(cell.map((r) => r.score)))} | $${sum(costs).toFixed(4)} | $${mean(costs).toFixed(4)} | ${sum(cell.map((r) => r.delegations))} |`,
		);
	}

	const baseline = runs.filter((run) => run.arm === "baseline");
	const fusion = runs.filter((run) => run.arm === "fusion");
	if (baseline.length > 0 && fusion.length > 0) {
		const baseCost = mean(baseline.map((run) => run.totalCost));
		const fusionCost = mean(fusion.map((run) => run.totalCost));
		const delta = ((baseCost - fusionCost) / baseCost) * 100;
		lines.push("");
		lines.push(
			`**Cost delta:** fusion is ${delta >= 0 ? `${delta.toFixed(1)}% cheaper` : `${Math.abs(delta).toFixed(1)}% more expensive`} per task ` +
				`(${pct(mean(baseline.map((r) => r.score)))} → ${pct(mean(fusion.map((r) => r.score)))} score).`,
		);
		const zeroDeleg = fusion.filter((run) => run.delegations === 0).length;
		if (zeroDeleg > 0) {
			lines.push("");
			lines.push(
				`**Note:** ${zeroDeleg}/${fusion.length} fusion runs delegated nothing — those are baseline runs carrying extra prompt overhead.`,
			);
		}
		lines.push("");
		lines.push(
			`**Fixed prompt overhead:** first-turn input tokens averaged ${Math.round(mean(baseline.map((r) => r.firstTurnInput)))} (baseline) vs ${Math.round(mean(fusion.map((r) => r.firstTurnInput)))} (fusion).`,
		);
	}
	return lines.join("\n");
}

const mean = (values) => (values.length === 0 ? 0 : sum(values) / values.length);
const sum = (values) => values.reduce((acc, value) => acc + value, 0);
const pct = (value) => `${(value * 100).toFixed(0)}%`;

function parseArgs(argv) {
	const parsed = {
		reps: 3,
		main: "openai-codex/gpt-5.6-sol",
		sidekick: "openai-codex/gpt-5.6-luna",
		tasks: [],
		arms: ["baseline", "fusion"],
		timeoutMs: 420_000,
		keep: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const next = () => argv[(index += 1)];
		if (arg === "--reps") parsed.reps = Number.parseInt(next(), 10);
		else if (arg === "--main") parsed.main = next();
		else if (arg === "--sidekick") parsed.sidekick = next();
		else if (arg === "--tasks") parsed.tasks = next().split(",").filter(Boolean);
		else if (arg === "--arms") parsed.arms = next().split(",").filter(Boolean);
		else if (arg === "--timeout") parsed.timeoutMs = Number.parseInt(next(), 10) * 1000;
		else if (arg === "--keep") parsed.keep = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return parsed;
}

await main();
