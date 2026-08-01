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
import { CodexAppServerClient } from "./app-server-client.js";

const dirs: string[] = [];
const clients: CodexAppServerClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Spawn a fake app-server: `node <script>` instead of `codex app-server`. */
function inlineClient(script: string): CodexAppServerClient {
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
  const client = new CodexAppServerClient({ command: process.execPath, args: [file] });
  clients.push(client);
  return client;
}

describe("CodexAppServerClient", () => {
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
    const client = inlineClient(`setOnLine(() => { process.exit(0); });`);
    client.onNotification(() => {});
    client.start();
    await expect(client.request("thread/start")).rejects.toThrow(/exited|closed/i);
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
});
