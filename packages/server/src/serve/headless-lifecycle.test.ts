import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { startHeadlessServer, type HeadlessServer } from "./headless-server.js";

// A controlled stdio worker exposes the actual Core create() publication
// boundaries: directory, state, then transcript. The host remains a real
// authenticated HTTP/WS server, and its worker response router is unmocked.
const WORKER = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const pending = new Map();
const output = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value})+'\n');
const notify = (method,params) => output({method,params});
const records = m => [
  {id:'user-'+m.id,type:'message',timestamp:123,turnNumber:0,data:{role:'user',content:m.params.task}},
  {id:'assistant-'+m.id,type:'message',timestamp:124,turnNumber:0,data:{role:'assistant',content:'Finished '+m.params.task}},
];
function materialize(m, stage) {
  const dir = path.join(process.env.CODE_SHELL_DATA_ROOT,'sessions',m.params.sessionId);
  if (stage==='absent') return;
  fs.mkdirSync(dir,{recursive:true});
  if (stage==='directory') return;
  fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify({sessionId:m.params.sessionId,cwd:m.params.cwd,startedAt:123,model:'fixture',status:'active',turnCount:0}));
  if (stage==='state') return;
  fs.writeFileSync(path.join(dir,'transcript.jsonl'),records(m).map(x=>JSON.stringify(x)).join('\n')+'\n');
}
readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);
  if(m.method==='agent/run') {
    pending.set(m.id,m);
    materialize(m,m.params.task.split(':')[0]);
    notify('agent/runAccepted',{requestId:m.id,sessionId:m.params.sessionId});
    notify('agent/streamEvent',{sessionId:m.params.sessionId,event:{type:'text_delta',text:'Live '+m.params.task}});
    notify('test/ready',{task:m.params.task});
  } else if(m.method==='test/finish') {
    for(const [id,run] of pending) if(run.params.task===m.params.task) {
      materialize(run,'complete'); pending.delete(id); output({id,result:{completed:true}});
    }
  } else if(m.method==='test/crash') process.exit(3);
  else if(m.method==='agent/cancel') {
    for(const [id,run] of pending) if(run.params.sessionId===m.params.sessionId) {
      pending.delete(id); output({id,result:{cancelled:true}});
    }
    output({id:m.id,result:{cancelled:true}});
  } else if(m.method==='agent/configure') output({id:m.id,result:{ok:true}});
});
`;

const fixtures: Array<{ dir: string; server: HeadlessServer }> = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const { server, dir } of fixtures.splice(0)) {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "cs-hub-lifecycle-"));
  const cwd = join(dir, "workspace");
  mkdirSync(join(cwd, ".code-shell", "skills", "fixture"), { recursive: true });
  writeFileSync(
    join(cwd, ".code-shell", "skills", "fixture", "SKILL.md"),
    "---\nname: fixture\ndescription: Lifecycle fixture\n---\nFixture body.\n",
  );
  const workerEntryPath = join(dir, "worker.cjs");
  writeFileSync(workerEntryPath, WORKER);
  const server = await startHeadlessServer({
    host: "127.0.0.1",
    port: 0,
    cwd,
    dataDir: join(dir, "data"),
    workerEntryPath,
    authMode: "hub",
    execPath: process.execPath,
    authRecheckMs: 20,
    pendingWorkerResponseTtlMs: 50,
    pendingWorkerResponseReaperMs: 10,
  });
  fixtures.push({ dir, server });
  const login = async (setup = false) => {
    const response = await fetch(server.url + `/api/v1/auth/${setup ? "setup" : "login"}`, {
      method: "POST",
      headers: { origin: server.url, "content-type": "application/json" },
      body: JSON.stringify({
        token: server.bootstrapToken,
        username: "fixture",
        password: "lifecycle-fixture-password",
      }),
    });
    expect(response.status).toBe(200);
    return {
      cookie: response.headers.get("set-cookie")!.split(";", 1)[0]!,
      body: (await response.json()) as any,
    };
  };
  const first = await login(true);
  const save = (cookie = first.cookie) =>
    fetch(server.url + "/api/v1/configuration/skills", {
      method: "PUT",
      headers: { cookie, origin: server.url, "content-type": "application/json" },
      body: JSON.stringify({ name: "fixture", enabled: false }),
    });
  const control = (method: "finish" | "crash", task?: string) =>
    server.bridge.injectWorkerMessage(
      JSON.stringify({ jsonrpc: "2.0", method: `test/${method}`, params: { task } }),
      { origin: "serve", producer: "test" },
    );
  return { dir, server, first, login, save, control };
}

async function connect(server: HeadlessServer, cookie: string) {
  const ws = new WebSocket(server.url.replace("http:", "ws:") + "/ws", {
    headers: { cookie, origin: server.url },
  });
  sockets.push(ws);
  const received: any[] = [];
  ws.on("message", (line) => received.push(JSON.parse(String(line))));
  ws.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    ws.once("unexpected-response", (_request, response) =>
      reject(new Error(`Upgrade rejected: ${response.statusCode}`)),
    );
  });
  const wait = async (predicate: (message: any) => boolean): Promise<any> => {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const result = received.find(predicate);
      if (result) return result;
      await Bun.sleep(5);
    }
    throw new Error(`Missing WS message; received ${JSON.stringify(received)}`);
  };
  const send = (id: string, method: string, params: unknown) =>
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  const detail = async (id: string, sessionId: string) => {
    send(id, "agent/query", { type: "session_detail", sessionId });
    return wait((message) => message.id === id);
  };
  return { ws, received, wait, send, detail };
}

for (const stage of ["absent", "directory", "state"]) {
  test(`refresh replays a tracked run while its ${stage} storage is being materialized`, async () => {
    const { server, first, save, control } = await fixture();
    const origin = await connect(server, first.cookie);
    origin.send("run", "agent/run", { sessionId: "new-session", task: stage });
    await origin.wait((message) => message.method === "test/ready");
    origin.ws.terminate();
    const client = await connect(server, first.cookie);
    const snapshot = await client.detail("refresh", "new-session");
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.result.data.running).toBe(true);
    expect(snapshot.result.data.transcript).toEqual([]);
    expect(snapshot.result.data.liveStream.events.map((item: any) => item.event.type)).toEqual([
      "session_user_message",
      "text_delta",
    ]);
    expect((await save()).status).toBe(409);
    control("finish", stage);
    await client.wait(
      (message) => message.method === "serve/sessionStatus" && !message.params.running,
    );
    const final = await client.detail("completed", "new-session");
    expect(final.result.data.running).toBe(false);
    expect(final.result.data.liveStream).toBeUndefined();
    expect(final.result.data.transcript).toHaveLength(2);
    expect((await save()).status).toBe(200);
  });
}

test("a tracked new run can be cancelled before its first state file exists", async () => {
  const { server, first, save } = await fixture();
  const client = await connect(server, first.cookie);
  client.send("run", "agent/run", { sessionId: "not-yet-persisted", task: "absent" });
  await client.wait((message) => message.method === "test/ready");
  client.send("stop", "agent/cancel", { sessionId: "not-yet-persisted" });
  const cancelled = await client.wait((message) => message.id === "stop");
  expect(cancelled.error).toBeUndefined();
  expect(cancelled.result.cancelled).toBe(true);
  expect((await client.wait((message) => message.id === "run")).result.cancelled).toBe(true);
  expect((await save()).status).toBe(200);
});

test("new-run replay recovery never hides corrupt state or a different workspace", async () => {
  const { dir, server, first } = await fixture();
  const client = await connect(server, first.cookie);
  client.send("run", "agent/run", { sessionId: "unsafe-active", task: "state" });
  await client.wait((message) => message.method === "test/ready");
  const statePath = join(dir, "data", "worker", "sessions", "unsafe-active", "state.json");
  writeFileSync(statePath, "{broken");
  expect((await client.detail("corrupt", "unsafe-active")).error).toBeDefined();
  writeFileSync(
    statePath,
    JSON.stringify({ sessionId: "unsafe-active", cwd: join(dir, "another-workspace") }),
  );
  expect((await client.detail("foreign", "unsafe-active")).error).toBeDefined();
});

test("disappearance of an existing conversation transcript does not become an empty replay", async () => {
  const { dir, server, first, control } = await fixture();
  const client = await connect(server, first.cookie);
  client.send("first", "agent/run", { sessionId: "existing", task: "complete:first" });
  await client.wait((message) => message.method === "test/ready");
  control("finish", "complete:first");
  await client.wait((message) => message.id === "first");
  client.send("second", "agent/run", { sessionId: "existing", task: "complete:second" });
  await client.wait((message) => message.params?.task === "complete:second");
  rmSync(join(dir, "data", "worker", "sessions", "existing", "transcript.jsonl"));
  expect((await client.detail("missing-history", "existing")).error).toBeDefined();
});

test("overlapping same-session requests retain the replay and configuration gate until both settle", async () => {
  const { server, first, save, control } = await fixture();
  const client = await connect(server, first.cookie);
  client.send("first", "agent/run", { sessionId: "shared", task: "complete:first" });
  await client.wait((message) => message.method === "test/ready");
  client.send("second", "agent/run", { sessionId: "shared", task: "complete:second" });
  await client.wait((message) => message.params?.task === "complete:second");
  control("finish", "complete:second");
  await client.wait((message) => message.id === "second");
  const middle = await client.detail("middle", "shared");
  expect(middle.result.data.running).toBe(true);
  expect(middle.result.data.transcript).toEqual([]);
  expect(middle.result.data.liveStream.events).toHaveLength(4);
  expect((await save()).status).toBe(409);
  control("finish", "complete:first");
  await client.wait((message) => message.id === "first");
  expect((await client.detail("final", "shared")).result.data.running).toBe(false);
  expect((await save()).status).toBe(200);
});

test("worker exit releases detached runs and a replacement worker advances the existing host cursor", async () => {
  const { server, first, save, control } = await fixture();
  const origin = await connect(server, first.cookie);
  origin.send("before", "agent/run", { sessionId: "survivor", task: "complete:before" });
  await origin.wait((message) => message.method === "test/ready");
  const initial = (await origin.detail("initial", "survivor")).result.data;
  const generation = server.bridge.workerGeneration();
  origin.ws.terminate();
  const client = await connect(server, first.cookie);
  expect((await save()).status).toBe(409);
  control("crash");
  await client.wait((message) => message.method === "serve/workerExit");
  const crashed = (await client.detail("crashed", "survivor")).result.data;
  expect(crashed.running).toBe(false);
  expect(crashed.liveStream).toBeUndefined();
  expect(server.pendingResponseCount()).toBe(0);
  expect((await save()).status).toBe(200);
  client.send("after", "agent/run", { sessionId: "survivor", task: "complete:after" });
  await client.wait((message) => message.method === "test/ready");
  const restarted = (await client.detail("restarted", "survivor")).result.data;
  expect(restarted.running).toBe(true);
  expect(restarted.streamCursor.epoch).toBe(initial.streamCursor.epoch);
  expect(restarted.streamCursor.sequence).toBeGreaterThan(initial.streamCursor.sequence);
  expect(server.bridge.workerGeneration()).toBeGreaterThan(generation);
  control("finish", "complete:after");
  await client.wait((message) => message.id === "after");
  expect((await save()).status).toBe(200);
});

test("revoking a running device removes its access while another administrator can finish the task", async () => {
  const { server, first, login, save } = await fixture();
  const second = await login();
  const owner = await connect(server, second.cookie);
  owner.send("run", "agent/run", { sessionId: "revoked-owner", task: "complete:active" });
  await owner.wait((message) => message.method === "test/ready");
  const closed = new Promise<number>((resolve) => owner.ws.once("close", resolve));
  const revoke = await fetch(server.url + `/api/v1/auth/sessions/${second.body.session.id}`, {
    method: "DELETE",
    headers: { cookie: first.cookie, origin: server.url },
  });
  expect(revoke.status).toBe(200);
  expect(await closed).toBe(4401);
  expect((await save(second.cookie)).status).toBe(401);
  expect((await save()).status).toBe(409);
  const controller = await connect(server, first.cookie);
  expect((await controller.detail("active", "revoked-owner")).result.data.running).toBe(true);
  controller.send("stop", "agent/cancel", { sessionId: "revoked-owner" });
  expect((await controller.wait((message) => message.id === "stop")).result.cancelled).toBe(true);
  expect((await save()).status).toBe(200);
});
