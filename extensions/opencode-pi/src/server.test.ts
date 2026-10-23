import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import test from "node:test";
import { launch, redactSecret, validateServerOrigin } from "./server.js";

function fakeChild() {
  const child = new EventEmitter() as unknown as ChildProcess & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { unref(): void };
    kill: () => void;
  };
  Object.assign(child, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { unref() {} },
    kill() {},
    unref() {},
    exitCode: null,
  });
  return child;
}

const fakeSpawn = (child: ChildProcess) => (() => child) as unknown as typeof spawn;

test("validateServerOrigin accepts every loopback form the server can report", () => {
  for (const url of [
    "http://127.0.0.1:4096",
    "http://[::1]:4096",
    "http://localhost:4096",
    "https://127.0.0.1:8443",
  ]) {
    assert.equal(validateServerOrigin(url), new URL(url).origin);
  }
});

test("validateServerOrigin rejects a non-loopback origin", () => {
  for (const url of [
    "https://evil.example:4096",
    "http://0.0.0.0:4096",
    "http://192.168.1.10:4096",
  ]) {
    assert.throws(() => validateServerOrigin(url), /non-loopback origin/);
  }
});

test("validateServerOrigin rejects a URL that carries credentials", () => {
  assert.throws(
    () => validateServerOrigin("http://opencode:hunter2@127.0.0.1:4096"),
    (error: Error) => {
      assert.match(error.message, /credentials/);
      assert.ok(!error.message.includes("hunter2"), "the rejected URL is never echoed");
      return true;
    },
  );
});

test("validateServerOrigin rejects a URL without an explicit port", () => {
  assert.throws(() => validateServerOrigin("http://127.0.0.1"), /port/);
});

test("validateServerOrigin rejects a protocol that is not http", () => {
  assert.throws(() => validateServerOrigin("file://127.0.0.1/x"), /protocol/);
});

test("launch rejects a non-loopback banner before resolving a server", async () => {
  const child = fakeChild();
  let killed = false;
  child.kill = () => {
    killed = true;
    return true;
  };
  const started = launch("opencode", {}, fakeSpawn(child));
  child.stdout.emit("data", Buffer.from("listening on https://evil.example:4096\n"));
  await assert.rejects(started, /non-loopback origin/);
  assert.equal(killed, true, "the rejected server is stopped");
});

test("launch resolves a loopback banner and only then builds the authorization", async () => {
  const child = fakeChild();
  const started = launch("opencode", {}, fakeSpawn(child));
  child.stdout.emit("data", Buffer.from("listening on http://127.0.0.1:4096\n"));
  const server = await started;
  assert.equal(server.url, "http://127.0.0.1:4096");
  assert.match(server.authorization, /^Basic /);
});

test("redactSecret removes the password in every form it can appear", () => {
  const secret = "a1b2c3d4";
  const text = [
    `password=${secret}`,
    `OPENCODE_SERVER_PASSWORD=${secret}`,
    `crash dump: ${secret}`,
  ].join("\n");
  const redacted = redactSecret(text, secret);
  assert.ok(!redacted.includes(secret), "no form of the password survives");
  assert.equal(redacted.match(/\*\*\*/g)?.length, 3);
});

test("redactSecret leaves the buffer alone when there is no secret to remove", () => {
  assert.equal(redactSecret("plain output", "unused"), "plain output");
  assert.equal(redactSecret("plain output", ""), "plain output");
});

test("redactSecret keeps a 20 000 character buffer free of the password", () => {
  const secret = "9f8e7d6c";
  const fill = "x".repeat(20_000);
  const redacted = redactSecret(`${secret}${fill} password=${secret} ${secret}`, secret);
  assert.ok(!redacted.includes(secret));
  assert.ok(redacted.length <= 20_000 + 30, "the buffer does not grow");
});
