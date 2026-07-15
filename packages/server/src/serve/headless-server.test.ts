// packages/server/src/serve/headless-server.test.ts
//
// Integration tests for the headless serve entry: HTTP passcode gate + static
// UI hosting + the WS ↔ stdio-worker JSON-RPC pipe. A tiny echo worker script
// (same pattern as worker-bridge-core.test.ts) stands in for the real
// agent-server-stdio, so the pipe is exercised end to end without an LLM.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { startHeadlessServer, type HeadlessServer } from "./headless-server.js";

const WORKER_SCRIPT = `
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { echo: msg.params ?? null } }) + "\\n");
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "test/received", params: { method: msg.method } }) + "\\n");
    }
  }
});
`;

const PASSCODE = "serve-test-passcode";

let dir: string;
let entryPath: string;
let staticDir: string;
const servers: HeadlessServer[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cs-headless-serve-"));
  entryPath = join(dir, "echo-worker.cjs");
  writeFileSync(entryPath, WORKER_SCRIPT);
  staticDir = join(dir, "webapp");
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>cs web</title>ROOT_OK");
  writeFileSync(join(staticDir, "app.js"), "// app js");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function boot(options: { seedSession?: boolean } = {}): Promise<HeadlessServer> {
  const runtimeDir = mkdtempSync(join(dir, "runtime-"));
  const sessionRootDir = join(runtimeDir, "sessions");
  if (options.seedSession) {
    const sessionDir = join(sessionRootDir, "session-in-workspace");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "state.json"),
      JSON.stringify({
        sessionId: "session-in-workspace",
        kind: "work",
        cwd: dir,
        startedAt: 123,
        model: "test-model",
        status: "completed",
        turnCount: 1,
      }),
    );
    writeFileSync(
      join(sessionDir, "transcript.jsonl"),
      `${JSON.stringify({
        id: "m1",
        type: "message",
        timestamp: 123,
        turnNumber: 0,
        data: { role: "user", content: "Readable session title" },
      })}\n`,
    );
    const otherSessionDir = join(sessionRootDir, "session-outside-workspace");
    mkdirSync(otherSessionDir, { recursive: true });
    writeFileSync(
      join(otherSessionDir, "state.json"),
      JSON.stringify({
        sessionId: "session-outside-workspace",
        kind: "work",
        cwd: join(dir, "other-workspace"),
        startedAt: 456,
        model: "test-model",
        status: "completed",
        turnCount: 1,
      }),
    );
  }
  const server = await startHeadlessServer({
    host: "127.0.0.1",
    port: 0,
    cwd: dir,
    dataDir: join(runtimeDir, "serve-data"),
    workerEntryPath: entryPath,
    sessionRootDir,
    execPath: process.execPath,
    staticRootDir: staticDir,
    passcode: PASSCODE,
  });
  servers.push(server);
  return server;
}

function wsUrl(server: HeadlessServer): string {
  return `${server.url.replace(/^http/, "ws")}/ws`;
}

async function openWs(server: HeadlessServer, headers?: Record<string, string>): Promise<WebSocket> {
  const ws = new WebSocket(wsUrl(server), { headers });
  // Swallow late error emissions (a rejected upgrade fires 'unexpected-response'
  // AND 'error' when the socket dies) so they never become unhandled.
  ws.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (e) => reject(e instanceof Error ? e : new Error(String(e))));
    ws.once("unexpected-response", (_req, res) => reject(new Error(`upgrade rejected: ${res.statusCode}`)));
  });
  return ws;
}

function nextMessage(ws: WebSocket, predicate?: (msg: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for ws message")), 5_000);
    const onMsg = (data: unknown): void => {
      const msg = JSON.parse(String(data)) as Record<string, unknown>;
      if (predicate && !predicate(msg)) return;
      clearTimeout(timer);
      ws.off("message", onMsg);
      resolve(msg);
    };
    ws.on("message", onMsg);
  });
}

describe("headless serve — HTTP gate + static", () => {
  test("unauthenticated page request gets the passcode challenge, not the app", async () => {
    const server = await boot();
    const res = await fetch(`${server.url}/`, { headers: { accept: "text/html" } });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("访问口令");
  });

  test("correct passcode unlocks the static app and sets a remember cookie", async () => {
    const server = await boot();
    const res = await fetch(`${server.url}/?passcode=${PASSCODE}`, { headers: { accept: "text/html" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ROOT_OK");
    expect(res.headers.get("set-cookie") ?? "").toContain("cs_access=");
  });

  test("remember cookie works for subsequent asset requests; traversal is blocked", async () => {
    const server = await boot();
    const first = await fetch(`${server.url}/?passcode=${PASSCODE}`, { headers: { accept: "text/html" } });
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0]!;
    const asset = await fetch(`${server.url}/app.js`, { headers: { cookie } });
    expect(asset.status).toBe(200);
    const evil = await fetch(`${server.url}/..%2f..%2fetc%2fpasswd`, { headers: { cookie } });
    expect([400, 404]).toContain(evil.status);
  });

  test("unknown paths fall back to index.html (SPA routing) once authenticated", async () => {
    const server = await boot();
    const first = await fetch(`${server.url}/?passcode=${PASSCODE}`, { headers: { accept: "text/html" } });
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0]!;
    const spa = await fetch(`${server.url}/sessions/abc`, { headers: { cookie, accept: "text/html" } });
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain("ROOT_OK");
  });
});

describe("headless serve — WS pipe", () => {
  test("upgrade without credentials is rejected", async () => {
    const server = await boot();
    // bun's ws client surfaces the refused upgrade as an opaque ErrorEvent, so
    // assert the rejection itself; the accepted-upgrade path is covered by the
    // three authenticated tests below.
    await expect(openWs(server)).rejects.toThrow();
  });

  test("request frames round-trip through the worker; responses come back", async () => {
    const server = await boot();
    const ws = await openWs(server, { "x-access-passcode": PASSCODE });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: "r1", method: "agent/run", params: { task: "hi" } }));
    const reply = await nextMessage(ws, (m) => m.id === "r1");
    expect(reply.result).toEqual({ echo: { task: "hi", cwd: dir } });
    ws.close();
  });

  test("session queries are persisted, workspace-scoped, and include a readable preview", async () => {
    const server = await boot({ seedSession: true });
    const ws = await openWs(server, { "x-access-passcode": PASSCODE });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: "s1", method: "agent/query", params: { type: "sessions" } }));
    const listReply = await nextMessage(ws, (m) => m.id === "s1");
    expect(listReply.result).toEqual({
      type: "sessions",
      data: [
        {
          sessionId: "session-in-workspace",
          cwd: dir,
          startedAt: 123,
          model: "test-model",
          status: "completed",
          turnCount: 1,
          preview: "Readable session title",
        },
      ],
    });

    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: "s2",
      method: "agent/query",
      params: { type: "session_detail", sessionId: "session-in-workspace" },
    }));
    const detailReply = await nextMessage(ws, (m) => m.id === "s2");
    expect((detailReply.result as { type: string }).type).toBe("session_detail");
    ws.close();
  });

  test("worker notifications broadcast to every connected tab", async () => {
    const server = await boot();
    const a = await openWs(server, { "x-access-passcode": PASSCODE });
    const b = await openWs(server, { "x-access-passcode": PASSCODE });
    // First frame from either tab spawns the worker; a notification (no id)
    // is mirrored by the echo worker as test/received to ALL tabs.
    a.send(JSON.stringify({ jsonrpc: "2.0", method: "agent/ping", params: {} }));
    const [gotA, gotB] = await Promise.all([
      nextMessage(a, (m) => m.method === "test/received"),
      nextMessage(b, (m) => m.method === "test/received"),
    ]);
    expect((gotA.params as { method: string }).method).toBe("agent/ping");
    expect((gotB.params as { method: string }).method).toBe("agent/ping");
    a.close();
    b.close();
  });

  test("malformed frames are dropped without killing the pipe", async () => {
    const server = await boot();
    const ws = await openWs(server, { "x-access-passcode": PASSCODE });
    ws.send("not json at all");
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: "r2", method: "agent/query", params: { type: "tools" } }));
    const reply = await nextMessage(ws, (m) => m.id === "r2");
    expect(reply.result).toEqual({ echo: { type: "tools" } });
    ws.close();
  });
});
