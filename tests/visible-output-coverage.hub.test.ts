import { afterAll, expect, test } from "bun:test";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Reserve the only permitted endpoint before any Core/Host/worker import.
const reserve = http.createServer();
await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
const port = (reserve.address() as net.AddressInfo).port;
await new Promise<void>((resolve, reject) =>
  reserve.close((error) => (error ? reject(error) : resolve())),
);
const origin = `http://127.0.0.1:${port}`;
const originals: Array<() => void> = [];
let denied = 0;
function patch(target: any, name: string, make: (previous: any) => any) {
  const descriptor = Object.getOwnPropertyDescriptor(target, name)!;
  originals.push(() => Object.defineProperty(target, name, descriptor));
  target[name] = make(target[name]);
}
function deny(): never {
  denied++;
  throw Error("coverage Hub fixture denied network");
}
function exact(value: string) {
  if (new URL(value).origin !== origin) deny();
}
patch(globalThis, "fetch", (original) => (input: any, init?: any) => {
  exact(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (init?.dispatcher) deny();
  return original(input, { ...init, redirect: "error" });
});
for (const key of ["request", "get"]) {
  patch(https, key, () => deny);
  patch(
    http,
    key,
    (original) =>
      function (this: any, input: any, ...args: any[]) {
        const u = typeof input === "string" || input instanceof URL ? new URL(input) : undefined;
        const o = u ? (args[0] ?? {}) : input;
        if (o.socketPath || o.lookup) deny();
        exact(
          `${o.protocol ?? u?.protocol ?? "http:"}//${o.hostname ?? o.host ?? u?.hostname}:${o.port ?? u?.port}`,
        );
        return original.call(this, input, ...args);
      },
  );
}
patch(
  net.Socket.prototype,
  "connect",
  (original) =>
    function (this: any, ...args: any[]) {
      let o = args[0];
      if (Array.isArray(o)) o = o[0];
      if (typeof o !== "object" || o.path || o.host !== "127.0.0.1" || Number(o.port) !== port)
        deny();
      return original.apply(this, args);
    },
);
syncBuiltinESMExports();
expect(() => fetch("https://outside.invalid")).toThrow("denied network");
expect(() => https.get("https://outside.invalid")).toThrow("denied network");
const { startHeadlessServer } = await import("../packages/server/src/serve/headless-server.js");
const { SessionManager } = await import("../packages/core/src/index.js");
const { SessionOutputJournal } = await import("../packages/core/src/session/output-journal.js");
const { lockSync } = await import("../packages/core/src/utils/lockfile.js");
const { chatFromOutputJournal } = await import("../packages/web/app/chat.js");
const { WebSocket } = createRequire(new URL("../packages/server/package.json", import.meta.url))(
  "ws",
);
afterAll(() => {
  const failures: unknown[] = [];
  try {
    expect(denied).toBe(2);
  } catch (cause) {
    failures.push(cause);
  } finally {
    for (const restore of originals.reverse()) {
      try {
        restore();
      } catch (cause) {
        failures.push(cause);
      }
    }
    try {
      syncBuiltinESMExports();
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Hub coverage fixture cleanup failed");
});

test("real authenticated Hub WS + controlled stdio producer retains coverage after run finish/Host restart and rejects workspace/revocation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coverage-hub-")),
    cwd = join(dir, "workspace"),
    dataDir = join(dir, "host"),
    root = join(dir, "worker", "sessions");
  mkdirSync(cwd, { recursive: true });
  const manager = new SessionManager(root);
  const seed = (id: string, workspace = cwd) => {
    const s = manager.create(workspace, "fixture", "fixture", id);
    manager.startSessionRun(s.state, "run");
    const j = new SessionOutputJournal(root, id, "run", s.transcript.getEvents()[0].id);
    const events = [
      { type: "session_user_message", text: "question", clientMessageId: "input" },
      { type: "stream_request_start", turnNumber: 1, messageId: "reply" },
      { type: "text_delta", text: "actual durable answer" },
      { type: "turn_complete", reason: "completed", turnNumber: 1 },
    ].map((event) => ({ ...event, outputCursor: j.append(event as any) }));
    return { events, j };
  };
  const healthy = seed("healthy"),
    blocked = seed("blocked"),
    gap = seed("gap");
  seed("outside", join(dir, "outside"));
  writeFileSync(
    join(dir, "events.json"),
    JSON.stringify({ healthy: healthy.events, blocked: blocked.events, gap: gap.events }),
  );
  // The actual child is stdlib-only, confined before it installs the producer.
  // It emits controlled events; it is not a replacement model or fake journal.
  const entry = join(dir, "producer.cjs");
  writeFileSync(
    entry,
    `const fs=require('node:fs'),http=require('node:http'),https=require('node:https'),net=require('node:net');
let denied=0;const deny=()=>{denied++;throw Error('producer denied network')};globalThis.fetch=deny;http.get=http.request=https.get=https.request=net.connect=net.createConnection=net.Socket.prototype.connect=deny;
try{fetch('https://outside.invalid')}catch{}try{https.get('https://outside.invalid')}catch{}
fs.appendFileSync(${JSON.stringify(join(dir, "child-guards.jsonl"))},JSON.stringify({pid:process.pid,denied})+'\\n');
const events=JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, "events.json"))},'utf8'));
const send=o=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...o})+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='agent/run'){
const id=m.params.sessionId;
if(m.params.task==='before-state'){
 send({method:'agent/runAccepted',params:{requestId:m.id,sessionId:id}});
 const pending=setInterval(()=>{const fresh=JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, "events.json"))},'utf8'));if(fresh[id]){clearInterval(pending);for(const event of fresh[id])send({method:'agent/streamEvent',params:{sessionId:id,event}});send({id:m.id,result:{completed:true}})}},2);
 return;
}
if(m.params.task==='gap'||m.params.task==='locked')send({method:'agent/streamEvent',params:{sessionId:id,event:{type:'background_agent_completed',agentId:'late',description:'done',finalText:'controlled late result',status:'completed',enqueuedAt:1}}});
else for(const event of events[id]??[])send({method:'agent/streamEvent',params:{sessionId:id,event}});
send({id:m.id,result:{completed:true}});
}else send({id:m.id,result:{}})});`,
  );
  let server: Awaited<ReturnType<typeof startHeadlessServer>> | undefined;
  const sockets: InstanceType<typeof WebSocket>[] = [];
  const logs: string[] = [];
  const boot = async () =>
    (server = await startHeadlessServer({
      host: "127.0.0.1",
      port,
      cwd,
      dataDir,
      sessionRootDir: root,
      workerEntryPath: entry,
      execPath: process.execPath,
      authMode: "hub",
      publicOrigin: origin,
      log: (event) => logs.push(event),
    }));
  const post = async (path: string, body: any, cookie?: string) =>
    fetch(origin + path, {
      method: "POST",
      headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  const login = async (setup = false) => {
    const r = await post(`/api/v1/auth/${setup ? "setup" : "login"}`, {
      token: server?.bootstrapToken,
      username: "fixture",
      password: "coverage-only-test-password",
    });
    expect(r.status).toBe(200);
    return r.headers.get("set-cookie")!.split(";", 1)[0]!;
  };
  const connect = async (cookie: string) => {
    const ws = new WebSocket(origin.replace("http:", "ws:") + "/ws", {
      headers: { cookie, origin },
    });
    sockets.push(ws);
    const messages: any[] = [];
    ws.on("message", (line) => messages.push(JSON.parse(String(line))));
    ws.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    let n = 0;
    const rpc = async (method: string, params: any) => {
      const id = `test-${++n}`;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      const end = Date.now() + 3000;
      while (Date.now() < end) {
        const r = messages.find((x) => x.id === id);
        if (r) return r;
        await Bun.sleep(2);
      }
      throw Error("Hub RPC timed out");
    };
    const query = async (type: string, sessionId: string, options = {}) => {
      const response = await rpc("agent/query", { type, sessionId, ...options });
      if (response.error) throw Error(response.error.message);
      return response.result.data;
    };
    const recover = async (id: string) =>
      chatFromOutputJournal(
        await query("session_detail", id, { outputRecovery: true }),
        (options) => query("output_journal", id, options),
        [],
        () => undefined,
        () => query("output_coverage", id),
      );
    return { ws, messages, rpc, query, recover };
  };
  try {
    await boot();
    let cookie = await login(true),
      client = await connect(cookie);
    expect(
      (
        await client.rpc("agent/run", {
          sessionId: "healthy",
          task: "question",
          clientMessageId: "input",
          model: "fixture",
        })
      ).result.completed,
    ).toBe(true);
    expect(
      (await client.recover("healthy"))?.chat.items.some(
        (x) => x.kind === "assistant" && x.text === "actual durable answer",
      ),
    ).toBe(true);
    const prestateRun = client.rpc("agent/run", {
      sessionId: "prestate",
      task: "before-state",
      clientMessageId: "input",
      model: "fixture",
    });
    const acceptedDeadline = Date.now() + 3000;
    while (
      !client.messages.some(
        (x) => x.method === "agent/runAccepted" && x.params.sessionId === "prestate",
      )
    ) {
      if (Date.now() > acceptedDeadline) throw Error("Missing actual runAccepted before state");
      await Bun.sleep(2);
    }
    expect(
      client.messages.some(
        (x) => x.method === "agent/streamEvent" && x.params.sessionId === "prestate",
      ),
    ).toBe(false);
    const prestate = seed("prestate");
    writeFileSync(
      join(dir, "events.json"),
      JSON.stringify({
        healthy: healthy.events,
        blocked: blocked.events,
        gap: gap.events,
        prestate: prestate.events,
      }),
    );
    expect((await prestateRun).result.completed).toBe(true);
    expect(
      client.messages.some(
        (x) =>
          x.method === "agent/streamEvent" &&
          x.params.sessionId === "prestate" &&
          x.params.event.type === "session_user_message" &&
          typeof x.params.event.outputCursor === "string",
      ),
    ).toBe(true);
    // A metadata lock failure drops the event, leaves a live uncertainty barrier,
    // and neither escapes the stdio listener nor bans a later recorded run.
    const release = lockSync(join(root, "blocked", "state.json"), {
      realpath: false,
      retries: 0,
      stale: 10000,
      update: 5000,
    });
    try {
      expect(
        (await client.rpc("agent/run", { sessionId: "blocked", task: "locked", model: "fixture" }))
          .result.completed,
      ).toBe(true);
    } finally {
      release();
    }
    expect(
      client.messages.some(
        (x) => x.method === "agent/streamEvent" && x.params.sessionId === "blocked",
      ),
    ).toBe(false);
    expect(logs).toContain("stream.coverage_unavailable");
    expect(
      (
        await client.rpc("agent/run", {
          sessionId: "blocked",
          task: "question",
          model: "fixture",
          clientMessageId: "input",
        })
      ).result.completed,
    ).toBe(true);
    await expect(client.recover("blocked")).rejects.toThrow("unpaired");
    expect(
      (await client.rpc("agent/run", { sessionId: "gap", task: "gap", model: "fixture" })).result
        .completed,
    ).toBe(true);
    expect(
      client.messages.some(
        (x) =>
          x.method === "agent/streamEvent" && x.params.event.type === "background_agent_completed",
      ),
    ).toBe(true);
    expect((await client.query("session_detail", "gap")).liveStream).toBeUndefined();
    await expect(client.recover("gap")).rejects.toThrow("unpaired");
    await expect(client.query("output_coverage", "outside")).rejects.toThrow("workspace");
    client.ws.terminate();
    await server!.close();
    server = undefined;
    await boot();
    cookie = await login();
    client = await connect(cookie);
    expect((await client.recover("healthy"))?.outputCursor).toBeDefined();
    expect((await client.recover("blocked"))?.outputCursor).toBeDefined();
    expect((await client.recover("prestate"))?.outputCursor).toBeDefined();
    await expect(client.recover("gap")).rejects.toThrow("unpaired");
    const closed = new Promise<number>((resolve) => client.ws.once("close", resolve));
    expect((await post("/api/v1/auth/logout", {}, cookie)).status).toBe(200);
    expect(await closed).toBe(4401);
    const guards = readFileSync(join(dir, "child-guards.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(guards.length).toBe(1);
    expect(guards[0].denied).toBe(2);
  } finally {
    for (const socket of sockets) socket.terminate();
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
