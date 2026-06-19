import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROVIDER_ID = "apple-fm";

/** Pi budgeting default — matches ~4k on-device `system` limit (not 128k). Override with APPLE_FM_PI_CONTEXT_WINDOW. */
const DEFAULT_CONTEXT = 4096;
const MAX_ALLOWED_CONTEXT = 131_072;

/** Extension root (parent of src/). */
export function extensionRoot(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..");
}

export type AppleFmConfig = {
	host: string;
	fmPort: number;
	proxyPort: number;
	baseUrl: string;
	fmBin: string;
	autoStart: boolean;
	useProxy: boolean;
	contextWindow: number;
	maxTokens: number;
	agentDir: string;
	proxyScript: string;
	pidFileProxy: string;
	pidFileFm: string;
	logFileProxy: string;
	logFileFm: string;
};

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function parsePort(raw: string | undefined, fallback: number): number {
	if (!raw) return fallback;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 1 || n > 65_535) return fallback;
	return n;
}

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number {
	if (!raw) return fallback;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 1) return fallback;
	return Math.min(n, max);
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
	if (raw === undefined || raw === "") return fallback;
	const v = raw.toLowerCase();
	if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
	if (v === "0" || v === "false" || v === "no" || v === "off") return false;
	return fallback;
}

/** Read config from environment (used by extension and tests). */
export function loadAppleFmConfig(env: NodeJS.ProcessEnv = process.env): AppleFmConfig {
	const host = env.APPLE_FM_PI_HOST ?? env.FM_HOST ?? "127.0.0.1";
	const fmPort = parsePort(env.APPLE_FM_PI_FM_PORT ?? env.FM_PORT, 1976);
	const proxyPort = parsePort(env.APPLE_FM_PI_PROXY_PORT ?? env.PROXY_PORT, 1977);
	const useProxy = parseBool(env.APPLE_FM_PI_USE_PROXY, false);
	const dir = agentDir();
	const contextWindow = parsePositiveInt(
		env.APPLE_FM_PI_CONTEXT_WINDOW,
		DEFAULT_CONTEXT,
		MAX_ALLOWED_CONTEXT,
	);
	const maxTokensDefault = contextWindow <= 8192 ? Math.min(2048, contextWindow) : contextWindow;
	const maxTokens = parsePositiveInt(env.APPLE_FM_PI_MAX_TOKENS, maxTokensDefault, MAX_ALLOWED_CONTEXT);

	const clientPort = useProxy ? proxyPort : fmPort;

	return {
		host,
		fmPort,
		proxyPort,
		baseUrl: `http://${host}:${clientPort}/v1`,
		fmBin: env.APPLE_FM_PI_FM_BIN ?? "fm",
		autoStart: parseBool(env.APPLE_FM_PI_AUTO_START, true),
		useProxy,
		contextWindow,
		maxTokens,
		agentDir: dir,
		proxyScript: join(extensionRoot(), "vendor", "fm-proxy", "fm-proxy.cjs"),
		pidFileProxy: join(dir, "apple-fm-pi-proxy.pid"),
		pidFileFm: join(dir, "apple-fm-pi-fm-serve.pid"),
		logFileProxy: join(dir, "logs", "apple-fm-pi-proxy.log"),
		logFileFm: join(dir, "logs", "apple-fm-pi-fm-serve.log"),
	};
}

export const CONTEXT_WINDOW_NOTE =
	"Tool schemas are flattened in-extension (fm-proxy logic). Apple's on-device limit is still ~4k effective tokens for system — use `fm token-count`. Set APPLE_FM_PI_USE_PROXY=true to use the full HTTP proxy instead.";

export const PCC_FOREGROUND_NOTE =
	"PCC requires fm serve in a foreground Terminal (macOS attribution). Use /apple-fm-pi launch-terminal for full stack, or run bin/fm-launch.sh. Background fm serve: system works, pcc returns 503.";