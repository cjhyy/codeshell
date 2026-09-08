import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { startHeadlessServer, type HeadlessServer } from "./headless-server.js";

const PASSWORD = "only-a-test-password";
const fixtures: Array<{ dir: string; servers: HeadlessServer[] }> = [];
const sockets: WebSocket[] = [];
const WORKER = `
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const reply = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', id, result})+'\n');
const notify = (method, params) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', method, params})+'\n');
let pendingRun;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'agent/run') {
    const {sessionId = 'test-session', cwd, task} = m.params;
    const dir = path.join(process.env.CODE_SHELL_DATA_ROOT, 'sessions', sessionId);
    fs.mkdirSync(dir, {recursive:true});
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({sessionId,cwd,startedAt:123,model:'test',status:'completed',turnCount:1}));
    fs.writeFileSync(path.join(dir, 'transcript.jsonl'), JSON.stringify({id:'one',type:'message',timestamp:123,turnNumber:0,data:{role:'user',content:task}})+'\n');
    if (task === 'approval' || task === 'slow') pendingRun = m;
    else reply(m.id, {echo:m.params,credentialMode:process.env.CODE_SHELL_CREDENTIAL_ACCESS});
    if (task === 'approval') notify('agent/approvalRequest',{sessionId,requestId:'test-approval',connectionId:'worker-connection',generation:7,request:{toolName:'Write',args:{},description:'Write fixture',riskLevel:'medium'}});
    if (task === 'slow') setTimeout(()=>reply(m.id,{completed:true}),150);
  } else if (m.method === 'agent/approve') {
    notify('test/decision', m.params);
    setTimeout(()=>{
      notify('agent/approvalResolved', {sessionId:m.params.sessionId,requestId:m.params.requestId});
      reply(m.id,{accepted:true});
      if(pendingRun) reply(pendingRun.id,{completed:true});
    },50);
  } else reply(m.id,{echo:m.params});
});
`.replaceAll("+'\n'", "+'\\n'");

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const fixture of fixtures.splice(0)) {
    for (const server of fixture.servers) await server.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

async function fixture(
  options: {
    execPath?: string;
    script?: string;
    log?: (event: string, data?: Record<string, unknown>) => void;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "cs-hub-test-"));
  const item = { dir, servers: [] as HeadlessServer[] };
  fixtures.push(item);
  const cwd = join(dir, "workspace");
  const staticRootDir = join(dir, "app");
  mkdirSync(cwd);
  mkdirSync(staticRootDir);
  writeFileSync(join(staticRootDir, "index.html"), "HUB_SHELL");
  const workerEntryPath = join(dir, "worker.cjs");
  writeFileSync(workerEntryPath, options.script ?? WORKER);
  const boot = async () => {
    const server = await startHeadlessServer({
      cwd,
      dataDir: join(dir, "data"),
      workerEntryPath,
      staticRootDir,
      authMode: "hub",
      port: 0,
      execPath: options.execPath ?? process.execPath,
      log: options.log,
      authRecheckMs: 20,
      pendingWorkerResponseTtlMs: 60,
      pendingWorkerResponseReaperMs: 10,
    });
    item.servers.push(server);
    return server;
  };
  const server = await boot();
  return { ...item, cwd, server, boot };
}

async function json(server: HeadlessServer, path: string, body: unknown, cookie?: string) {
  return fetch(server.url + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: server.url,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function login(server: HeadlessServer, setup = false) {
  const response = await json(server, `/api/v1/auth/${setup ? "setup" : "login"}`, {
    token: server.bootstrapToken,
    username: "admin",
    password: PASSWORD,
    deviceName: setup ? "first" : "second",
  });
  expect(response.status).toBe(200);
  return {
    cookie: response.headers.get("set-cookie")!.split(";", 1)[0]!,
    body: (await response.json()) as any,
  };
}

async function connect(server: HeadlessServer, cookie: string, origin = server.url) {
  const ws = new WebSocket(server.url.replace("http:", "ws:") + "/ws", {
    headers: { cookie, origin },
  });
  sockets.push(ws);
  const received: any[] = [];
  ws.on("message", (line) => received.push(JSON.parse(String(line))));
  ws.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`upgrade ${res.statusCode}`)));
  });
  const wait = (predicate: (message: any) => boolean): Promise<any> =>
    new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const match = received.find(predicate);
        if (match) {
          clearInterval(timer);
          resolve(match);
        } else if (Date.now() - start > 4_000) {
          clearInterval(timer);
          reject(new Error("missing WS message"));
        }
      }, 5);
    });
  return {
    ws,
    received,
    wait,
    send: (id: string, method: string, params: unknown) =>
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })),
  };
}

test("Hub public shell and health expose no API data; setup is one-time and Origin gates WS", async () => {
  const { server } = await fixture();
  expect(await (await fetch(server.url + "/health")).json()).toEqual({ status: "ok", mode: "hub" });
  expect(await (await fetch(server.url)).text()).toBe("HUB_SHELL");
  expect((await fetch(server.url + "/api/v1/uploads/anything")).status).toBe(401);
  await expect(connect(server, "")).rejects.toBeDefined();
  const { cookie } = await login(server, true);
  await expect(connect(server, cookie, "https://evil.example")).rejects.toBeDefined();
  expect(
    (
      await json(server, "/api/v1/auth/setup", {
        token: server.bootstrapToken,
        username: "admin",
        password: PASSWORD,
      })
    ).status,
  ).toBe(409);
  const client = await connect(server, cookie);
  client.send("run", "agent/run", { sessionId: "run-session", task: "hello", cwd: "/etc" });
  const reply = await client.wait((m) => m.id === "run");
  expect(reply.result.echo.cwd).toContain("workspace");
  expect(reply.result.credentialMode).toBe("local");
});

test("device revoke actively closes its live socket and prevents future access", async () => {
  const { server } = await fixture();
  const first = await login(server, true);
  const second = await login(server);
  const client = await connect(server, second.cookie);
  const closed = new Promise<number>((resolve) => client.ws.once("close", resolve));
  const response = await fetch(`${server.url}/api/v1/auth/sessions/${second.body.session.id}`, {
    method: "DELETE",
    headers: { cookie: first.cookie, origin: server.url },
  });
  expect(response.status).toBe(200);
  expect(await closed).toBe(4401);
  await expect(connect(server, second.cookie)).rejects.toBeDefined();
  expect(
    (await fetch(server.url + "/api/v1/auth/sessions", { headers: { cookie: first.cookie } }))
      .status,
  ).toBe(200);
});

test("configuration is authenticated, refuses active tasks and hot-reloads without restarting", async () => {
  const { server, cwd } = await fixture({
    script: WORKER.replace(
      "} else reply(m.id,{echo:m.params});",
      "} else if(m.method === 'agent/configure') { notify('test/configuring', {}); setTimeout(() => reply(m.id,{ok:true}),200); } else reply(m.id,{echo:m.params});",
    ),
  });
  const skillDir = join(cwd, ".code-shell", "skills", "hub-test-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: hub-test-skill\ndescription: Fixture skill\n---\nUse fixture.\n",
  );
  writeFileSync(
    join(cwd, ".code-shell", "settings.local.json"),
    JSON.stringify({
      defaults: { text: "hub-first" },
      modelConnections: [
        { id: "hub-first", catalogId: "openai", tag: "text", model: "first" },
        { id: "hub-next", catalogId: "openai", tag: "text", model: "next" },
      ],
    }),
  );
  expect((await fetch(server.url + "/api/v1/configuration")).status).toBe(401);
  const { cookie } = await login(server, true);
  const update = (origin = server.url) =>
    fetch(server.url + "/api/v1/configuration/skills", {
      method: "PUT",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ name: "hub-test-skill", enabled: false }),
    });
  expect((await update("https://elsewhere.example")).status).toBe(403);
  const client = await connect(server, cookie);
  client.send("waiting", "agent/run", { sessionId: "configuration-session", task: "approval" });
  await client.wait((m) => m.method === "agent/approvalRequest");
  expect((await update()).status).toBe(409);
  expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toContain("Use fixture.");
  client.send("approve-config", "agent/approve", {
    sessionId: "configuration-session",
    requestId: "test-approval",
    decision: { approved: true },
  });
  await client.wait((m) => m.id === "waiting");
  const generation = server.bridge.workerGeneration();
  const saving = update();
  await client.wait((m) => m.method === "test/configuring");
  client.send("during-config", "agent/run", { sessionId: "blocked-session", task: "hello" });
  expect((await client.wait((m) => m.id === "during-config")).error.code).toBe(-32009);
  const response = await saving;
  expect(response.status).toBe(200);
  const snapshot = (await response.json()) as any;
  expect(snapshot.skills.find((s: any) => s.name === "hub-test-skill").enabled).toBe(false);
  await client.wait((m) => m.method === "serve/configurationChanged");
  expect(client.received.some((m) => m.method === "serve/workerExit")).toBe(false);
  client.send("after-config", "agent/run", { sessionId: "configuration-session", task: "hello" });
  expect((await client.wait((m) => m.id === "after-config")).result.echo.model).toBe("hub-first");
  expect(
    (
      await fetch(server.url + "/api/v1/configuration/defaults", {
        method: "PUT",
        headers: { cookie, origin: server.url, "content-type": "application/json" },
        body: JSON.stringify({ text: "hub-next" }),
      })
    ).status,
  ).toBe(200);
  client.send("new-default", "agent/run", { sessionId: "configuration-session", task: "hello" });
  expect((await client.wait((m) => m.id === "new-default")).result.echo.model).toBe("hub-next");
  client.send("explicit-model", "agent/run", {
    sessionId: "configuration-session",
    task: "hello",
    model: "hub-first",
  });
  expect((await client.wait((m) => m.id === "explicit-model")).result.echo.model).toBe("hub-first");
  expect(server.bridge.workerGeneration()).toBe(generation);
});

test("failed hot reload blocks tasks until a successful save and never terminates the worker", async () => {
  const { server, cwd } = await fixture({
    script: WORKER.replace("let pendingRun;", "let pendingRun; let configured = false;").replace(
      "} else reply(m.id,{echo:m.params});",
      "} else if (m.method === 'agent/configure') { if (!configured) { configured = true; process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'fixture reload failure'}})+'\\n'); } else reply(m.id,{ok:true}); } else reply(m.id,{echo:m.params});",
    ),
  });
  mkdirSync(join(cwd, ".code-shell"));
  writeFileSync(
    join(cwd, ".code-shell", "settings.local.json"),
    JSON.stringify({
      defaults: { text: "hub-model" },
      modelConnections: [{ id: "hub-model", catalogId: "openai", tag: "text", model: "fixture" }],
    }),
  );
  const { cookie } = await login(server, true);
  const client = await connect(server, cookie);
  client.send("start", "agent/run", { sessionId: "reload-failure", task: "hello" });
  await client.wait((m) => m.id === "start");
  const generation = server.bridge.workerGeneration();
  const save = () =>
    fetch(server.url + "/api/v1/configuration/defaults", {
      method: "PUT",
      headers: { cookie, origin: server.url, "content-type": "application/json" },
      body: JSON.stringify({ text: "hub-model" }),
    });
  expect((await save()).status).toBe(503);
  client.send("blocked", "agent/run", { sessionId: "reload-failure", task: "hello" });
  expect((await client.wait((m) => m.id === "blocked")).error.code).toBe(-32009);
  expect((await save()).status).toBe(200);
  client.send("recovered", "agent/run", { sessionId: "reload-failure", task: "hello" });
  expect((await client.wait((m) => m.id === "recovered")).result.echo.model).toBe("hub-model");
  expect(server.bridge.workerGeneration()).toBe(generation);
  expect(client.received.some((m) => m.method === "serve/workerExit")).toBe(false);
});

test("long-running turns outlive response TTL and persistent sessions survive host restart", async () => {
  const item = await fixture();
  const { cookie } = await login(item.server, true);
  const client = await connect(item.server, cookie);
  client.send("slow", "agent/run", { sessionId: "persisted", task: "slow" });
  expect((await client.wait((m) => m.id === "slow")).result).toEqual({ completed: true });
  await item.server.close();
  item.servers.splice(item.servers.indexOf(item.server), 1);
  const restarted = await item.boot();
  expect(restarted.bootstrapToken).toBeUndefined();
  const resumed = await connect(restarted, cookie);
  resumed.send("list", "agent/query", { type: "sessions" });
  const list = await resumed.wait((m) => m.id === "list");
  expect(list.result.data.map((s: any) => s.sessionId)).toContain("persisted");
  resumed.send("detail", "agent/query", { type: "session_detail", sessionId: "persisted" });
  expect((await resumed.wait((m) => m.id === "detail")).result.data.transcript).toHaveLength(1);
});

test("reconnected tabs see pending approvals and simultaneous decisions reach the worker once", async () => {
  const { server } = await fixture();
  const { cookie } = await login(server, true);
  const first = await connect(server, cookie);
  first.send("run", "agent/run", { sessionId: "approval-session", task: "approval" });
  await first.wait((m) => m.method === "agent/approvalRequest");
  const second = await connect(server, cookie);
  expect(
    (await second.wait((m) => m.method === "serve/approvalSnapshot")).params.approvals,
  ).toHaveLength(1);
  const params = {
    sessionId: "approval-session",
    requestId: "test-approval",
    connectionId: "spoofed",
    generation: 123,
    decision: { approved: true },
  };
  first.send("a", "agent/approve", params);
  second.send("b", "agent/approve", params);
  const [a, b] = await Promise.all([
    first.wait((m) => m.id === "a"),
    second.wait((m) => m.id === "b"),
  ]);
  expect([a, b].filter((m) => m.error?.code === -32009)).toHaveLength(1);
  expect(first.received.filter((m) => m.method === "test/decision")).toHaveLength(1);
  expect(first.received.find((m) => m.method === "test/decision").params).toMatchObject({
    connectionId: "worker-connection",
    generation: 7,
  });
  await first.wait((m) => m.method === "agent/approvalResolved");
});

test("uploads are device-owned, staged inside the session and cannot supply arbitrary paths", async () => {
  const { server, cwd } = await fixture();
  const first = await login(server, true);
  const second = await login(server);
  const put = await fetch(server.url + "/api/v1/uploads/file-123456", {
    method: "PUT",
    headers: {
      cookie: first.cookie,
      origin: server.url,
      "x-file-name": "notes.txt",
      "content-type": "text/plain",
    },
    body: "fixture content",
  });
  expect(put.status).toBe(201);
  const foreign = await connect(server, second.cookie);
  foreign.send("foreign", "agent/run", {
    sessionId: "files",
    task: "read",
    uploadIds: ["file-123456"],
  });
  expect((await foreign.wait((m) => m.id === "foreign")).error.message).toMatch(/not found/);
  const own = await connect(server, first.cookie);
  own.send("own", "agent/run", {
    sessionId: "files",
    task: "read",
    uploadIds: ["file-123456"],
    attachments: [{ absPath: "/etc/passwd" }],
  });
  const attachments = (await own.wait((m) => m.id === "own")).result.echo.attachments;
  expect(attachments).toHaveLength(1);
  expect(attachments[0].absPath).toStartWith(
    join(realpathSync(cwd), ".code-shell", "attachments", "files"),
  );
  expect(readFileSync(attachments[0].absPath, "utf8")).toBe("fixture content");
  own.send("replay", "agent/run", {
    sessionId: "files",
    task: "again",
    uploadIds: ["file-123456"],
  });
  expect((await own.wait((m) => m.id === "replay")).error).toBeDefined();
});

test("upload path traversal and workspace attachment symlinks cannot overwrite outside files", async () => {
  const { server, cwd, dir } = await fixture();
  const { cookie } = await login(server, true);
  const headers = {
    cookie,
    origin: server.url,
    "content-type": "text/plain",
    "x-file-name": "..%2Fescape",
  };
  expect(
    (
      await fetch(server.url + "/api/v1/uploads/file-123456", {
        method: "PUT",
        headers,
        body: "data",
      })
    ).status,
  ).toBe(400);
  headers["x-file-name"] = "safe.txt";
  expect(
    (
      await fetch(server.url + "/api/v1/uploads/..%2Fescape", {
        method: "PUT",
        headers,
        body: "data",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await fetch(server.url + "/api/v1/uploads/file-123456", {
        method: "PUT",
        headers,
        body: "data",
      })
    ).status,
  ).toBe(201);
  mkdirSync(join(cwd, ".code-shell"));
  symlinkSync(dir, join(cwd, ".code-shell", "attachments"));
  const client = await connect(server, cookie);
  client.send("symlink", "agent/run", {
    sessionId: "files",
    task: "read",
    uploadIds: ["file-123456"],
  });
  expect((await client.wait((m) => m.id === "symlink")).error).toBeDefined();
});

test("worker spawn failure rejects long-running request instead of leaving UI pending", async () => {
  const { server } = await fixture({ execPath: "/nonexistent/codeshell-node" });
  const { cookie } = await login(server, true);
  const client = await connect(server, cookie);
  client.send("spawn", "agent/run", { sessionId: "failure", task: "hi" });
  expect((await client.wait((m) => m.id === "spawn")).error.message).toMatch(/worker/);
  expect(server.pendingResponseCount()).toBe(0);
});

test("approval error after submitting tab disconnects restores the card for another device", async () => {
  const script = WORKER.replace(
    "notify('test/decision', m.params);",
    "notify('test/decision', m.params); setTimeout(() => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32602,message:'retry decision'}})+'\\n'), 150); return;",
  );
  const { server } = await fixture({ script });
  const { cookie } = await login(server, true);
  const first = await connect(server, cookie);
  first.send("run", "agent/run", { sessionId: "approval-session", task: "approval" });
  await first.wait((m) => m.method === "agent/approvalRequest");
  const other = await connect(server, cookie);
  first.send("decision", "agent/approve", {
    sessionId: "approval-session",
    requestId: "test-approval",
    decision: { approved: true },
  });
  await first.wait((m) => m.method === "test/decision");
  first.ws.terminate();
  const initialSnapshots = other.received.filter(
    (m) => m.method === "serve/approvalSnapshot",
  ).length;
  await other.wait(
    (m) =>
      m.method === "serve/approvalSnapshot" &&
      other.received.filter((n) => n.method === "serve/approvalSnapshot").length > initialSnapshots,
  );
  const snapshots = other.received.filter((m) => m.method === "serve/approvalSnapshot");
  expect(snapshots.at(-1).params.approvals).toHaveLength(1);
});

test("worker failure releases an upload reservation so the same draft can be retried", async () => {
  const { server } = await fixture({ execPath: "/nonexistent/codeshell-node" });
  const { cookie } = await login(server, true);
  const put = await fetch(server.url + "/api/v1/uploads/retry-123456", {
    method: "PUT",
    headers: {
      cookie,
      origin: server.url,
      "x-file-name": "retry.txt",
      "content-type": "text/plain",
    },
    body: "keep this draft",
  });
  expect(put.status).toBe(201);
  const client = await connect(server, cookie);
  for (const id of ["first-attempt", "retry-attempt"]) {
    client.send(id, "agent/run", { sessionId: "retry", task: "read", uploadIds: ["retry-123456"] });
    expect((await client.wait((message) => message.id === id)).error.message).toMatch(/worker/);
  }
});

test("default host diagnostics omit raw task text", async () => {
  const logs: unknown[] = [];
  const { server } = await fixture({ log: (event, data) => logs.push({ event, data }) });
  const { cookie } = await login(server, true);
  const client = await connect(server, cookie);
  client.send("private", "agent/run", { sessionId: "private", task: "SENSITIVE_TASK_CONTENT_123" });
  await client.wait((message) => message.id === "private");
  expect(logs.length).toBeGreaterThan(0);
  expect(JSON.stringify(logs)).not.toContain("SENSITIVE_TASK_CONTENT_123");
});

test("Hub replay and run authorization reject unsafe or oversized persisted records without overwriting them", async () => {
  const { server, dir, cwd } = await fixture();
  const { cookie } = await login(server, true);
  const tab = await connect(server, cookie);
  const sessionId = "bounded-history";
  tab.send("seed-bounded", "agent/run", { sessionId, task: "Original task" });
  await tab.wait((message) => message.id === "seed-bounded");
  const root = join(dir, "data", "worker", "sessions", sessionId);
  const transcript = join(root, "transcript.jsonl");
  const originalTranscript = readFileSync(transcript);
  const state = join(root, "state.json");
  const originalState = readFileSync(state);
  const outside = join(dir, "private-other-workspace.jsonl");
  writeFileSync(
    outside,
    JSON.stringify({ type: "message", data: { role: "user", content: "FOREIGN_PRIVATE_TEXT" } }) +
      "\n",
  );
  rmSync(transcript);
  symlinkSync(outside, transcript);
  tab.send("unsafe-detail", "agent/query", { type: "session_detail", sessionId });
  const unsafeDetail = await tab.wait((message) => message.id === "unsafe-detail");
  expect(unsafeDetail.error).toBeDefined();
  expect(JSON.stringify(unsafeDetail)).not.toContain("FOREIGN_PRIVATE_TEXT");
  tab.send("unsafe-run", "agent/run", { sessionId, task: "Must not overwrite outside history" });
  expect((await tab.wait((message) => message.id === "unsafe-run")).error).toBeDefined();
  expect(readFileSync(outside, "utf8")).toContain("FOREIGN_PRIVATE_TEXT");
  rmSync(transcript);
  writeFileSync(transcript, originalTranscript);
  truncateSync(transcript, 33 * 1024 * 1024);
  tab.send("oversized-detail", "agent/query", { type: "session_detail", sessionId });
  expect((await tab.wait((message) => message.id === "oversized-detail")).error.message).toContain(
    "32 MB",
  );
  writeFileSync(transcript, originalTranscript);
  writeFileSync(state, "{broken");
  tab.send("broken-run", "agent/run", { sessionId, task: "Must not recreate corrupt session" });
  expect((await tab.wait((message) => message.id === "broken-run")).error).toBeDefined();
  expect(readFileSync(state, "utf8")).toBe("{broken");
  writeFileSync(
    state,
    JSON.stringify({ ...JSON.parse(originalState.toString()), cwd: join(dir, "other-workspace") }),
  );
  tab.send("foreign-detail", "agent/query", { type: "session_detail", sessionId });
  expect((await tab.wait((message) => message.id === "foreign-detail")).error).toBeDefined();
  writeFileSync(state, originalState);
  tab.send("healthy-again", "agent/run", { sessionId, task: "Continues after repair" });
  expect((await tab.wait((message) => message.id === "healthy-again")).result.echo.cwd).toBe(cwd);
});
