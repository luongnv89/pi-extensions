import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

const START_TIMEOUT_MS = 20_000;
const IDLE_SHUTDOWN_MS = 10 * 60_000;
const OUTPUT_LIMIT = 20_000;

// Runs `opencode serve` and stops it when its stdin closes, which happens
// whenever Pi exits, even on SIGKILL. Without it a killed Pi would leave the
// server running.
const WATCHDOG = `const { spawn } = require("node:child_process");
const [bin, ...args] = JSON.parse(process.env.OPENCODE_PI_SERVE_ARGV);
// OpenCode is a compiled Bun binary; BUN_BE_BUN would turn it into plain bun.
delete process.env.BUN_BE_BUN;
const child = spawn(bin, args, { stdio: ["ignore", "inherit", "inherit"] });
const stop = () => { child.kill("SIGTERM"); setTimeout(() => process.exit(0), 2000).unref(); };
process.stdin.on("end", stop);
process.stdin.on("error", stop);
process.stdin.resume();
process.on("SIGTERM", stop);
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (error) => { console.error(String(error)); process.exit(1); });`;

export type OpenCodeServer = {
  bin: string;
  url: string;
  authorization: string;
  child: ChildProcess;
};

export type ServerEvent = { type: string; properties?: any };

let server: Promise<OpenCodeServer> | undefined;
let running: OpenCodeServer | undefined;
let activeUses = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function launch(bin: string, env: NodeJS.ProcessEnv): Promise<OpenCodeServer> {
  const password = randomBytes(24).toString("hex");
  const child = spawn(process.execPath, ["-e", WATCHDOG], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...env,
      // Lets a compiled Bun host run the watchdog script as plain bun.
      BUN_BE_BUN: "1",
      OPENCODE_PI_SERVE_ARGV: JSON.stringify([
        bin, "serve", "--pure", "--hostname", "127.0.0.1", "--port", "0",
      ]),
      OPENCODE_SERVER_USERNAME: "opencode",
      OPENCODE_SERVER_PASSWORD: password,
    },
  });
  return new Promise((resolve, reject) => {
    let output = "";
    const fail = (message: string) => {
      clearTimeout(timer);
      child.kill("SIGTERM");
      reject(new Error(`${message}${output.trim() ? `: ${output.trim()}` : ""}`));
    };
    const timer = setTimeout(
      () => fail(`opencode serve did not start within ${START_TIMEOUT_MS}ms`),
      START_TIMEOUT_MS,
    );
    let ready = false;
    const onOutput = (chunk: Buffer) => {
      // Once ready, the listener only keeps the pipes drained.
      if (ready) return;
      output = (output + chunk.toString()).slice(-OUTPUT_LIMIT);
      const url = output.match(/listening on (https?:\/\/\S+)/)?.[1];
      if (!url) return;
      ready = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.on("exit", () => forget(instance));
      const instance: OpenCodeServer = {
        bin,
        url,
        authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        child,
      };
      // The server must not keep Pi alive; the watchdog stops it on exit.
      child.unref();
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        (stream as unknown as { unref?: () => void } | null)?.unref?.();
      }
      resolve(instance);
    };
    const onExit = (code: number | null) =>
      fail(`opencode serve exited with code ${code} before it was ready`);
    child.stdout!.on("data", onOutput);
    child.stderr!.on("data", onOutput);
    child.on("exit", onExit);
    child.on("error", (error) => fail(error.message));
  });
}

function forget(instance: OpenCodeServer): void {
  if (running !== instance) return;
  running = undefined;
  server = undefined;
}

async function ensureServer(bin: string, env: NodeJS.ProcessEnv): Promise<OpenCodeServer> {
  const current = await server?.catch(() => undefined);
  if (current && current.bin === bin && current.child.exitCode === null) {
    return current;
  }
  if (current) stopOpenCodeServer();
  const started = launch(bin, env);
  server = started;
  try {
    running = await started;
    return running;
  } catch (error) {
    if (server === started) server = undefined;
    throw error;
  }
}

/**
 * Run `use` against the shared OpenCode server, starting it if needed. The
 * server stops after {@link IDLE_SHUTDOWN_MS} without a turn.
 */
export async function withOpenCodeServer<T>(
  bin: string,
  env: NodeJS.ProcessEnv,
  use: (server: OpenCodeServer) => Promise<T>,
): Promise<T> {
  activeUses += 1;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  try {
    return await use(await ensureServer(bin, env));
  } finally {
    activeUses -= 1;
    if (activeUses === 0) {
      idleTimer = setTimeout(stopOpenCodeServer, IDLE_SHUTDOWN_MS);
      idleTimer.unref?.();
    }
  }
}

/** The running server, if any, without starting one. */
export function runningOpenCodeServer(): OpenCodeServer | undefined {
  return running?.child.exitCode === null ? running : undefined;
}

export function stopOpenCodeServer(): void {
  const instance = running;
  running = undefined;
  server = undefined;
  instance?.child.kill("SIGTERM");
}

process.on("exit", stopOpenCodeServer);

export async function serverRequest(
  server: OpenCodeServer,
  method: string,
  path: string,
  directory: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<any> {
  const response = await fetch(
    `${server.url}${path}?directory=${encodeURIComponent(directory)}`,
    {
      method,
      headers: {
        authorization: server.authorization,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenCode ${method} ${path} failed with ${response.status}: ${text.slice(0, 500)}`);
  }
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Subscribe to the directory's event stream. Resolves once the server has
 * confirmed the subscription, so no event published after that is missed.
 */
export async function subscribeEvents(
  server: OpenCodeServer,
  directory: string,
  signal: AbortSignal,
): Promise<AsyncGenerator<ServerEvent>> {
  const response = await fetch(
    `${server.url}/event?directory=${encodeURIComponent(directory)}`,
    { headers: { authorization: server.authorization, accept: "text/event-stream" }, signal },
  );
  if (!response.ok || !response.body) {
    throw new Error(`OpenCode event stream failed with ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  const events = parseEvents(response.body);
  const first = await events.next();
  if (first.done || first.value.type !== "server.connected") {
    throw new Error("OpenCode event stream closed before it connected");
  }
  return events;
}

export async function* parseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ServerEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    // Normalize the whole buffer: a CRLF can be split across two chunks.
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, "\n");
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const data = buffer
        .slice(0, end)
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      buffer = buffer.slice(end + 2);
      if (!data) continue;
      try {
        yield JSON.parse(data) as ServerEvent;
      } catch {
        // Ignore malformed events instead of failing the turn.
      }
    }
  }
}
