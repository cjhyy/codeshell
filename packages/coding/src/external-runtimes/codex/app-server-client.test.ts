/**
 * Client tests against a FAKE app-server (a tiny node script speaking the same
 * NDJSON dialect), so CI needs no Codex binary and no login.
 *
 * The behaviours pinned here are the ones that cost real debugging cycles:
 * Codex omits the `jsonrpc` field, a server→client request must always be
 * answered, and a single unparsable line must not kill the session.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient, type AppServerClientOptions } from "./app-server-client.js";

const dirs: string[] = [];
const clients: CodexAppServerClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Spawn a fake app-server: `node <script>` instead of `codex app-server`. */
function inlineClient(script: string, log?: AppServerClientOptions["log"]): CodexAppServerClient {
  const dir = mkdtempSync(join(tmpdir(), "codeshell-fake-appserver-"));
  dirs.push(dir);
  const file = join(dir, "server.mjs");
  writeFileSync(
    file,
    `import { createInterface } from "node:readline";
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const raw = (text) => process.stdout.write(text + "\\n");
let onLine = () => {};
const setOnLine = (fn) => { onLine = fn; };
createInterface({ input: process.stdin }).on("line", (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  onLine(m);
});
${script}
`,
  );
  const client = new CodexAppServerClient({ command: process.execPath, args: [file], log });
  clients.push(client);
  return client;
}

describe("CodexAppServerClient", () => {
  test("reports a missing executable without logging arguments or environment values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codeshell-missing-appserver-"));
    dirs.push(dir);
    const command = join(dir, "missing-codex");
    const closed: Record<string, unknown>[] = [];
    const client = new CodexAppServerClient({
      command,
      cwd: dir,
      args: ["app-server", "private-argument-marker"],
      env: { ...process.env, PRIVATE_TEST_TOKEN: "private-env-marker" },
      log: (event, data) => {
        if (event === "appserver.closed") closed.push(data);
      },
    });
    clients.push(client);
    client.onNotification(() => {});
    client.start();

    await expect(client.request("initialize", {}, 1_000)).rejects.toThrow(
      /app-server failed to start.*ENOENT/,
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ command, cwd: dir, code: "ENOENT" });
    expect(closed[0].reason).toContain(command);
    expect(closed[0].reason).toContain(dir);
    expect(JSON.stringify(closed)).not.toContain("private-argument-marker");
    expect(JSON.stringify(closed)).not.toContain("private-env-marker");
    // Later requests retain the original startup failure, and close must not
    // wait for an exit event from a process that was never created.
    await expect(client.request("ping")).rejects.toThrow(/ENOENT/);
    await client.close();
    expect(closed).toHaveLength(1);
  });

  test("reports the working directory when an existing executable cannot spawn there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codeshell-missing-appserver-cwd-"));
    dirs.push(dir);
    const cwd = join(dir, "missing-directory");
    const closed: Record<string, unknown>[] = [];
    const client = new CodexAppServerClient({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd,
      log: (event, data) => {
        if (event === "appserver.closed") closed.push(data);
      },
    });
    clients.push(client);
    client.onNotification(() => {});
    client.start();

    await expect(client.request("initialize", {}, 1_000)).rejects.toThrow(/failed to start/);
    expect(closed[0]).toMatchObject({ command: process.execPath, cwd, code: "ENOENT" });
    expect(closed[0].reason).toContain(cwd);
  });

  test("bounds executable and OS error text in startup diagnostics", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codeshell-long-appserver-path-"));
    dirs.push(dir);
    const command = join(dir, ...Array<string>(50).fill("missing-folder"), "codex");
    const closed: Record<string, unknown>[] = [];
    const client = new CodexAppServerClient({
      command,
      cwd: dir,
      log: (event, data) => {
        if (event === "appserver.closed") closed.push(data);
      },
    });
    clients.push(client);
    client.onNotification(() => {});
    client.start();

    await expect(client.request("initialize", {}, 1_000)).rejects.toThrow(/failed to start/);
    expect(closed[0].command).toBe(command.slice(0, 300));
    expect(String(closed[0].error).length).toBeLessThanOrEqual(300);
    expect(String(closed[0].reason).length).toBeLessThan(1_000);
  });

  test("correlates a response that omits the jsonrpc field", async () => {
    // Codex's JSON-RPC does not send `jsonrpc: "2.0"`; discrimination is by shape.
    const client = inlineClient(`
      setOnLine((m) => { if (m.method === "ping") send({ id: m.id, result: { pong: true } }); });
    `);
    client.onNotification(() => {});
    client.start();
    await expect(client.request("ping")).resolves.toEqual({ pong: true });
  });

  test("delivers notifications, including ones pushed before the first request", async () => {
    const seen: string[] = [];
    const client = inlineClient(
      `send({ method: "thread/started", params: { thread: { id: "t" } } });`,
    );
    client.onNotification((method) => seen.push(method));
    client.start();
    await Bun.sleep(300);
    expect(seen).toContain("thread/started");
  });

  test("rejects a request with a correlated error response", async () => {
    const client = inlineClient(`
      setOnLine((m) => send({ id: m.id, error: { code: -32600, message: "Invalid request" } }));
    `);
    client.onNotification(() => {});
    client.start();
    await expect(client.request("thread/start")).rejects.toThrow(/Invalid request/);
  });

  test("always answers a server→client request, even an unhandled one", async () => {
    // An unanswered server request blocks the server forever.
    const client = inlineClient(`
      let replied = null;
      setOnLine((m) => {
        if (m.method === "collect") { send({ id: m.id, result: { replied } }); return; }
        if (m.error || m.result) { replied = m.error ? "error" : "result"; }
      });
      send({ id: 9001, method: "item/tool/requestUserInput", params: {} });
    `);
    client.onNotification(() => {});
    // No onServerRequest handler at all.
    client.start();
    await Bun.sleep(300);
    await expect(client.request("collect")).resolves.toEqual({ replied: "error" });
  });

  test("routes a server request to the handler and returns its result", async () => {
    const client = inlineClient(`
      let got = null;
      setOnLine((m) => {
        if (m.method === "collect") { send({ id: m.id, result: { got } }); return; }
        if (m.result) got = m.result;
      });
      send({ id: 42, method: "item/commandExecution/requestApproval", params: { cmd: "ls" } });
    `);
    client.onNotification(() => {});
    client.onServerRequest((method) =>
      method.includes("requestApproval") ? { decision: "decline" } : undefined,
    );
    client.start();
    await Bun.sleep(300);
    await expect(client.request("collect")).resolves.toEqual({ got: { decision: "decline" } });
  });

  test("survives an unparsable line", async () => {
    // The server may emit a banner; one bad line must not kill the session.
    const client = inlineClient(`
      raw("this is not json at all");
      setOnLine((m) => send({ id: m.id, result: { ok: true } }));
    `);
    client.onNotification(() => {});
    client.start();
    await Bun.sleep(200);
    await expect(client.request("ping")).resolves.toEqual({ ok: true });
  });

  test("a notification handler that throws does not stop the read loop", async () => {
    const client = inlineClient(`
      send({ method: "boom", params: {} });
      setOnLine((m) => send({ id: m.id, result: { alive: true } }));
    `);
    client.onNotification(() => {
      throw new Error("handler exploded");
    });
    client.start();
    await Bun.sleep(200);
    await expect(client.request("ping")).resolves.toEqual({ alive: true });
  });

  test("rejects in-flight requests when the process exits", async () => {
    const closed: Record<string, unknown>[] = [];
    const client = inlineClient(`setOnLine(() => { process.exit(23); });`, (event, data) => {
      if (event === "appserver.closed") closed.push(data);
    });
    client.onNotification(() => {});
    client.start();
    await expect(client.request("thread/start")).rejects.toThrow(/app-server exited \(code 23\)/);
    expect(closed[0]).toMatchObject({ code: 23, signal: null, command: process.execPath });
  });

  test("a timeout says the request may still have taken effect", async () => {
    // A timed-out turn/start does NOT mean the turn was not created; the message
    // has to say so or a caller will assume the opposite.
    const client = inlineClient(`setOnLine(() => {});`);
    client.onNotification(() => {});
    client.start();
    await expect(client.request("turn/start", {}, 120)).rejects.toThrow(
      /may still have taken effect/i,
    );
  });

  test("requests after close fail fast rather than hanging", async () => {
    const client = inlineClient(`setOnLine(() => {});`);
    client.onNotification(() => {});
    client.start();
    await client.close();
    await expect(client.request("ping")).rejects.toThrow(/closed/i);
    expect(client.isClosed).toBe(true);
  });

  test("close returns when the server has already exited from a signal", async () => {
    const client = inlineClient(`setOnLine(() => { process.kill(process.pid, "SIGTERM"); });`);
    client.onNotification(() => {});
    client.start();
    await expect(client.request("ping")).rejects.toThrow(/app-server exited \(signal SIGTERM\)/);
    await client.close();
    expect(client.isClosed).toBe(true);
  });
});
