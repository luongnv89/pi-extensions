import { spawn } from "node:child_process";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppleFmConfig } from "./config.js";
import { extensionRoot } from "./config.js";

export type FmHealth = {
	running: boolean;
	url: string;
	viaProxy: boolean;
	health?: {
		status?: string;
		models?: Array<{ name: string; available?: boolean; reason?: string }>;
	};
	error?: string;
};

export type EnsureResult = {
	ok: boolean;
	started: boolean;
	message: string;
	health?: FmHealth;
};

function healthUrl(cfg: AppleFmConfig): string {
	const port = cfg.useProxy ? cfg.proxyPort : cfg.fmPort;
	return `http://${cfg.host}:${port}/health`;
}

export async function fetchHealth(cfg: AppleFmConfig, timeoutMs = 3000): Promise<FmHealth> {
	const url = healthUrl(cfg);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) {
			return { running: false, url, viaProxy: cfg.useProxy, error: `HTTP ${res.status}` };
		}
		const health = (await res.json()) as FmHealth["health"];
		return { running: true, url, viaProxy: cfg.useProxy, health };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { running: false, url, viaProxy: cfg.useProxy, error: message };
	} finally {
		clearTimeout(timer);
	}
}

async function readPid(pidFile: string): Promise<number | null> {
	try {
		const raw = (await readFile(pidFile, "utf8")).trim();
		const pid = Number.parseInt(raw, 10);
		return Number.isFinite(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForHealthy(cfg: AppleFmConfig, attempts = 40): Promise<FmHealth> {
	for (let i = 0; i < attempts; i++) {
		const h = await fetchHealth(cfg, 2000);
		if (h.running) return h;
		await new Promise((r) => setTimeout(r, 250));
	}
	return fetchHealth(cfg);
}

async function spawnLogged(
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	logFile: string,
	pidFile: string,
): Promise<{ pid: number } | { error: string }> {
	await mkdir(dirname(logFile), { recursive: true });
	const logHandle = await open(logFile, "a").catch(() => null);
	const child = spawn(command, args, {
		detached: true,
		stdio: logHandle ? ["ignore", logHandle.fd, logHandle.fd] : "ignore",
		env: { ...process.env, ...env },
	});
	child.unref();
	if (!child.pid) {
		if (logHandle) await logHandle.close();
		return { error: `Failed to spawn ${command}` };
	}
	await writeFile(pidFile, `${child.pid}\n`, "utf8");
	return { pid: child.pid };
}

async function stopPidFile(pidFile: string): Promise<string | null> {
	const pid = await readPid(pidFile);
	if (pid && processAlive(pid)) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			/* ignore */
		}
		try {
			await unlink(pidFile);
		} catch {
			/* ignore */
		}
		return `stopped pid ${pid}`;
	}
	try {
		await unlink(pidFile);
	} catch {
		/* ignore */
	}
	return null;
}

async function fmServeHealthy(cfg: AppleFmConfig): Promise<boolean> {
	const url = `http://${cfg.host}:${cfg.fmPort}/health`;
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
		if (!res.ok) return false;
		const body = await res.text();
		return /running|available|status/i.test(body);
	} catch {
		return false;
	}
}

export async function startFmServe(cfg: AppleFmConfig): Promise<EnsureResult> {
	if (await fmServeHealthy(cfg)) {
		const health = await fetchHealth(cfg);
		return {
			ok: health.running,
			started: false,
			message: `fm serve already on :${cfg.fmPort}`,
			health,
		};
	}

	const spawned = await spawnLogged(
		cfg.fmBin,
		["serve", "--host", cfg.host, "--port", String(cfg.fmPort)],
		{},
		cfg.logFileFm,
		cfg.pidFileFm,
	);
	if ("error" in spawned) {
		return { ok: false, started: false, message: spawned.error };
	}

	for (let i = 0; i < 40; i++) {
		if (await fmServeHealthy(cfg)) break;
		await new Promise((r) => setTimeout(r, 250));
	}
	if (!(await fmServeHealthy(cfg))) {
		return {
			ok: false,
			started: true,
			message: `fm serve pid ${spawned.pid} but not healthy on :${cfg.fmPort}`,
		};
	}

	const health = await fetchHealth(cfg);
	return {
		ok: health.running,
		started: true,
		message: `Started fm serve on :${cfg.fmPort} (pid ${spawned.pid})`,
		health,
	};
}

export async function startProxy(cfg: AppleFmConfig): Promise<EnsureResult> {
	const listenUrl = `http://${cfg.host}:${cfg.proxyPort}/health`;
	try {
		const res = await fetch(listenUrl, { signal: AbortSignal.timeout(1500) });
		if (res.ok || res.status === 502) {
			const health = await fetchHealth(cfg);
			return {
				ok: health.running,
				started: false,
				message: `fm-proxy already listening on :${cfg.proxyPort}`,
				health,
			};
		}
	} catch {
		/* not up */
	}

	const spawned = await spawnLogged(
		process.execPath,
		[cfg.proxyScript],
		{
			FM_PORT: String(cfg.fmPort),
			PROXY_PORT: String(cfg.proxyPort),
		},
		cfg.logFileProxy,
		cfg.pidFileProxy,
	);
	if ("error" in spawned) {
		return { ok: false, started: false, message: spawned.error };
	}

	const health = await waitForHealthy(cfg);
	return {
		ok: health.running,
		started: true,
		message: `Started fm-proxy on :${cfg.proxyPort} → fm :${cfg.fmPort} (pid ${spawned.pid})`,
		health,
	};
}

/** Start fm serve + optional fm-proxy (OpenAI tool schema fix). */
export async function startStack(cfg: AppleFmConfig): Promise<EnsureResult> {
	const fm = await startFmServe(cfg);
	if (!fm.ok) return fm;

	if (!cfg.useProxy) {
		const health = await fetchHealth(cfg);
		return {
			ok: health.running,
			started: fm.started,
			message: `${fm.message}. Pi uses in-process tool fix at ${cfg.baseUrl}`,
			health,
		};
	}

	const proxy = await startProxy(cfg);
	if (!proxy.ok) {
		return {
			ok: false,
			started: true,
			message: `${fm.message}; proxy failed: ${proxy.message}`,
			health: proxy.health,
		};
	}

	return {
		ok: true,
		started: fm.started || proxy.started,
		message: `${fm.message}; ${proxy.message}. Pi base: ${cfg.baseUrl}`,
		health: proxy.health,
	};
}

export async function stopFmServe(cfg: AppleFmConfig): Promise<{ ok: boolean; message: string }> {
	const parts: string[] = [];
	if (cfg.useProxy) {
		const p = await stopPidFile(cfg.pidFileProxy);
		if (p) parts.push(`proxy ${p}`);
	}
	const f = await stopPidFile(cfg.pidFileFm);
	if (f) parts.push(`fm ${f}`);

	if (parts.length > 0) {
		return { ok: true, message: `Stopped ${parts.join("; ")}` };
	}

	const health = await fetchHealth(cfg);
	if (health.running) {
		return {
			ok: false,
			message:
				"Stack still running but not started by apple-fm-pi (no pid files). Stop manually or use the process that started it.",
		};
	}
	return { ok: true, message: "apple-fm stack is not running" };
}

export async function ensureFmServe(cfg: AppleFmConfig): Promise<EnsureResult> {
	if (!cfg.autoStart) {
		const health = await fetchHealth(cfg);
		if (health.running) {
			return { ok: true, started: false, message: "stack is running", health };
		}
		return {
			ok: false,
			started: false,
			message: `stack not running (${health.url}). Run /apple-fm-pi start`,
			health,
		};
	}
	return startStack(cfg);
}

/** Open macOS Terminal with foreground fm-launch (PCC attribution). */
export async function launchStackInTerminal(cfg: AppleFmConfig): Promise<{ ok: boolean; message: string }> {
	if (process.platform !== "darwin") {
		return { ok: false, message: "launch-terminal is only supported on macOS" };
	}
	const extRoot = extensionRoot();
	const launchSh = join(extRoot, "bin", "fm-launch.sh");
	const { access } = await import("node:fs/promises");
	try {
		await access(launchSh);
	} catch {
		return { ok: false, message: `fm-launch.sh not found at ${launchSh}` };
	}
	const cmd = `cd '${extRoot}' && FM_PORT=${cfg.fmPort} PROXY_PORT=${cfg.proxyPort} FM_BIN='${cfg.fmBin}' ./bin/fm-launch.sh`;
	const script = `tell application "Terminal" to do script "${cmd.replace(/"/g, '\\"')}"`;
	const child = spawn("osascript", ["-e", script], { stdio: "ignore", detached: true });
	child.unref();
	return {
		ok: true,
		message: `Opened Terminal with fm-launch (proxy :${cfg.proxyPort}, fm :${cfg.fmPort}). Keep that window open for PCC.`,
	};
}