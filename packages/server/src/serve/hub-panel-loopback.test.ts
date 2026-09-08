import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { installReviewedLocalPanelApp, previewLocalPanelApp } from "@cjhyy/code-shell-core";
import { startHeadlessServer, type HeadlessServer } from "./headless-server.js";

const PASSWORD = "panel-loopback-password-123";
const previousHome = process.env.HOME;
const fixtures: Array<{ root: string; server: HeadlessServer }> = [];
const sockets: WebSocket[] = [];
const roots: string[] = [];
const WORKER = `
const {createInterface}=require('node:readline');
const send=(value)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
const runs=new Map();
const queues=new Map();
function begin(frame){
 const sessionId=frame.params.sessionId;
 runs.set(sessionId,frame);
 if(frame.params.behaviorMode==='isolatedTask')return;
 send({method:'agent/approvalRequest',params:{sessionId,requestId:'panel-'+frame.id,connectionId:'loopback-worker',generation:23,request:{toolName:'__panel_action__',description:'Panel operation',riskLevel:'low',args:JSON.parse(frame.params.task)}}});
}
createInterface({input:process.stdin}).on('line',line=>{
 const frame=JSON.parse(line);
 if(frame.method==='agent/run'){
  const sessionId=frame.params.sessionId;
  if(runs.has(sessionId)){const queue=queues.get(sessionId)||[];queue.push(frame);queues.set(sessionId,queue);}else begin(frame);
 }else if(frame.method==='agent/approve'){
  const run=runs.get(frame.params.sessionId);
  if(frame.params.connectionId!=='loopback-worker'||frame.params.generation!==23||frame.params.decision?.approved!==true||typeof frame.params.decision.answer!=='string')
   return send({id:frame.id,error:{message:'invalid loopback decision'}});
  const answer=JSON.parse(frame.params.decision.answer);
  send({id:frame.id,result:{accepted:true}});
  if(run){send({id:run.id,result:{answer,decision:frame.params.decision,route:{connectionId:frame.params.connectionId,generation:frame.params.generation}}});runs.delete(frame.params.sessionId);const next=queues.get(frame.params.sessionId)?.shift();if(next)begin(next);}
 }else if(frame.method==='agent/cancel'){
  const run=runs.get(frame.params.sessionId);
  send({id:frame.id,result:{ok:true}});
  if(run){send({id:run.id,result:{text:'',reason:'aborted_streaming'}});runs.delete(frame.params.sessionId);}
 }else send({id:frame.id,result:{ok:true}});
});
`;

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const fixture of fixtures.splice(0)) {
    await fixture.server.close();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
});

async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const result = await read();
    if (predicate(result)) return result;
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for Panel loopback: ${JSON.stringify(result)}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hub-panel-loopback-"));
  roots.push(root);
  process.env.HOME = join(root, "home");
  const cwd = join(root, "workspace");
  const source = join(root, "source");
  mkdirSync(join(cwd, ".code-shell"), { recursive: true });
  mkdirSync(join(source, ".codeshell-panel"), { recursive: true });
  mkdirSync(join(source, "app"));
  writeFileSync(
    join(source, "app/index.html"),
    "<!doctype html><html><head></head><body>Panel fixture</body></html>",
  );
  writeFileSync(
    join(source, ".codeshell-panel/panel.json"),
    JSON.stringify({
      schemaVersion: 2,
      id: "hub-loopback",
      title: { default: "Hub loopback" },
      version: "1.0.0",
      entry: "app/index.html",
      icon: "panel",
      placement: "right-dock",
      singleton: true,
      permissions: ["context.workspace", "context.session", "agent.task"],
      agent: {
        tools: [
          {
            name: "read_panel",
            description: "Read this panel",
            inputSchema: {
              type: "object",
              properties: { marker: { type: "string" } },
              additionalProperties: false,
            },
            readOnly: true,
          },
        ],
        skills: [],
      },
    }),
  );
  writeFileSync(
    join(cwd, ".code-shell/settings.local.json"),
    JSON.stringify({
      defaults: { text: "panel-fixture" },
      modelConnections: [
        { id: "panel-fixture", catalogId: "openai", tag: "text", model: "gpt-4o-mini" },
      ],
    }),
  );
  const input = { kind: "dir" as const, path: source };
  const preview = await previewLocalPanelApp(input);
  await installReviewedLocalPanelApp(input, preview.reviewToken, new Date().toISOString());
  const workerEntryPath = join(root, "worker.cjs");
  writeFileSync(workerEntryPath, WORKER);
  const server = await startHeadlessServer({
    cwd,
    dataDir: join(root, "data"),
    workerEntryPath,
    staticRootDir: source,
    authMode: "hub",
    port: 0,
    authRecheckMs: 20,
  });
  fixtures.push({ root, server });
  const base = server.url;
  async function api(path: string, method = "GET", body?: unknown, cookie?: string) {
    return fetch(base + path, {
      method,
      headers: { origin: base, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function login(setup = false) {
    const response = await api(`/api/v1/auth/${setup ? "setup" : "login"}`, "POST", {
      token: server.bootstrapToken,
      username: "tester",
      password: PASSWORD,
    });
    expect(response.status).toBe(200);
    return response.headers.get("set-cookie")!.split(";", 1)[0]!;
  }
  const owner = await login(true);
  const catalog = (await (await api("/api/v1/panels", "GET", undefined, owner)).json()) as any;
  const bound = await api(
    "/api/v1/panels/hub-loopback/binding",
    "PATCH",
    { bound: true, expectedRevision: catalog.panels[0].revision },
    owner,
  );
  expect(bound.status).toBe(200);
  const revision = ((await bound.json()) as any).panels[0].revision;
  async function prepare(sessionId: string, cookie = owner) {
    const response = await api(
      "/api/v1/panels/runtime/prepare",
      "POST",
      { appId: "hub-loopback", revision, sessionId },
      cookie,
    );
    expect(response.status).toBe(200);
    const grant = (await response.json()) as any;
    const registered = await api(
      `/api/v1/panels/runtime/${grant.instanceId}/call`,
      "POST",
      { method: "tools.register", params: { name: "read_panel" } },
      cookie,
    );
    expect(registered.status).toBe(200);
    return grant as { instanceId: string };
  }
  async function events(instanceId: string, cookie = owner) {
    const response = await api(
      `/api/v1/panels/runtime/${instanceId}/events`,
      "GET",
      undefined,
      cookie,
    );
    expect(response.status).toBe(200);
    return (await response.json()) as { events: Array<{ event: string; payload: any }> };
  }
  async function connect(cookie = owner) {
    const ws = new WebSocket(base.replace("http:", "ws:") + "/ws", {
      headers: { cookie, origin: base },
    });
    sockets.push(ws);
    const received: any[] = [];
    ws.on("message", (line) => received.push(JSON.parse(String(line))));
    ws.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    let counter = 0;
    async function request(sessionId: string, action: Record<string, unknown>) {
      const id = `run-${++counter}`;
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "agent/run",
          params: { sessionId, task: JSON.stringify(action) },
        }),
      );
      return until(async () => received.find((item) => item.id === id), Boolean);
    }
    return {
      received,
      request,
      async run(sessionId: string, action: Record<string, unknown>) {
        const reply = await request(sessionId, action);
        expect(reply.error).toBeUndefined();
        return reply.result;
      },
    };
  }
  return { server, api, owner, login, prepare, events, connect };
}

test("main Hub Core Panel loopback reaches registered browser tools and returns their real result", async () => {
  const f = await fixture();
  const grant = await f.prepare("session-first");
  const differentSession = await f.prepare("session-other");
  const otherOwner = await f.login();
  const ownerGrant = await f.prepare("session-first", otherOwner);
  const client = await f.connect();
  const panelId = "panel-app:hub-loopback";
  const listed = await client.run("session-first", { action: "list" });
  expect(listed.answer).toMatchObject({ ok: true, panels: [{ id: panelId }] });
  expect(listed.route).toEqual({ connectionId: "loopback-worker", generation: 23 });
  const tools = await client.run("session-first", { action: "tools", panelId });
  expect(tools.answer.tools.map((tool: any) => tool.name)).toEqual(["read_panel"]);
  const pending = client.run("session-first", {
    action: "invoke",
    panelId,
    toolName: "read_panel",
    arguments: { marker: "actual-browser-result" },
  });
  const batch = await until(
    () => f.events(grant.instanceId),
    (value) => value.events.some((event) => event.event === "tools.invoke"),
  );
  const invocation = batch.events.find((event) => event.event === "tools.invoke")!.payload;
  expect(invocation).toMatchObject({
    toolName: "read_panel",
    args: { marker: "actual-browser-result" },
  });
  expect((await f.events(differentSession.instanceId)).events).toEqual([]);
  expect((await f.events(ownerGrant.instanceId, otherOwner)).events).toEqual([]);
  const reply = {
    requestId: invocation.requestId,
    result: { marker: "actual-browser-result", count: 3 },
  };
  expect(
    (
      await f.api(
        `/api/v1/panels/runtime/${grant.instanceId}/tool-results`,
        "POST",
        reply,
        otherOwner,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await f.api(
        `/api/v1/panels/runtime/${differentSession.instanceId}/tool-results`,
        "POST",
        reply,
        f.owner,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await f.api(
        `/api/v1/panels/runtime/${ownerGrant.instanceId}/tool-results`,
        "POST",
        reply,
        otherOwner,
      )
    ).status,
  ).toBe(400);
  expect(
    (await f.api(`/api/v1/panels/runtime/${grant.instanceId}/tool-results`, "POST", reply, f.owner))
      .status,
  ).toBe(200);
  const completed = await pending;
  expect(completed.answer).toMatchObject({
    ok: true,
    panelId,
    toolName: "read_panel",
    result: reply.result,
  });
  expect(JSON.parse(completed.decision.answer)).toEqual(completed.answer);
  expect(
    (await f.api(`/api/v1/panels/runtime/${grant.instanceId}/tool-results`, "POST", reply, f.owner))
      .status,
  ).toBe(400);
  expect(
    client.received.some(
      (message) =>
        message.method === "agent/approvalRequest" &&
        message.params?.request?.toolName === "__panel_action__",
    ),
  ).toBe(false);
  expect((await client.run("session-absent", { action: "list" })).answer).toEqual({
    ok: true,
    panels: [],
  });
  expect(
    (await client.run("session-absent", { action: "invoke", panelId, toolName: "read_panel" }))
      .answer.ok,
  ).toBe(false);
  const anotherClient = await f.connect(otherOwner);
  expect((await anotherClient.run("session-other", { action: "list" })).answer).toEqual({
    ok: true,
    panels: [],
  });
});

test("a running Panel session rejects another owner and retains its owner across queued turns", async () => {
  const f = await fixture();
  const grant = await f.prepare("queued-session");
  const otherOwner = await f.login();
  const otherGrant = await f.prepare("queued-session", otherOwner);
  const firstClient = await f.connect();
  const secondClient = await f.connect(otherOwner);
  const panelId = "panel-app:hub-loopback";
  const firstRun = firstClient.run("queued-session", {
    action: "invoke",
    panelId,
    toolName: "read_panel",
    arguments: {},
  });
  const batch = await until(
    () => f.events(grant.instanceId),
    (value) => value.events.some((event) => event.event === "tools.invoke"),
  );
  const invocation = batch.events.find((event) => event.event === "tools.invoke")!.payload;
  const rejected = await secondClient.request("queued-session", { action: "list" });
  expect(rejected.error?.code).toBe(-32009);
  const queuedRun = firstClient.run("queued-session", { action: "list" });
  expect((await f.events(otherGrant.instanceId, otherOwner)).events).toEqual([]);
  expect(
    (
      await f.api(
        `/api/v1/panels/runtime/${grant.instanceId}/tool-results`,
        "POST",
        { requestId: invocation.requestId, result: { source: "original-owner" } },
        f.owner,
      )
    ).status,
  ).toBe(200);
  expect((await firstRun).answer).toMatchObject({ ok: true, result: { source: "original-owner" } });
  expect((await queuedRun).answer).toMatchObject({ ok: true, panels: [{ id: panelId }] });
  // Once every turn has completed, another logged-in device may start its own turn.
  expect((await secondClient.run("queued-session", { action: "list" })).answer).toMatchObject({
    ok: true,
    panels: [{ id: panelId }],
  });
});

test("active independent Panel tasks block model configuration until cancellation completes", async () => {
  const f = await fixture();
  const grant = await f.prepare("session-task");
  const call = (method: string, params?: unknown) =>
    f.api(`/api/v1/panels/runtime/${grant.instanceId}/call`, "POST", { method, params }, f.owner);
  const pending = call("agent.task.start", {
    prompt: "hold",
    label: "Hold independent task",
    toolNames: [],
  });
  const batch = await until(
    () => f.events(grant.instanceId),
    (value) => value.events.some((event) => event.event === "host.confirm"),
  );
  const confirmation = batch.events.find((event) => event.event === "host.confirm")!.payload;
  expect(
    (
      await f.api(
        `/api/v1/panels/runtime/${grant.instanceId}/confirm`,
        "POST",
        { requestId: confirmation.requestId, allowed: true },
        f.owner,
      )
    ).status,
  ).toBe(200);
  const response = await pending;
  expect(response.status).toBe(200);
  const task = (await response.json()) as any;
  expect(task.status).toBe("running");
  const save = () =>
    f.api("/api/v1/configuration/defaults", "PUT", { text: "panel-fixture" }, f.owner);
  expect((await save()).status).toBe(409);
  expect((await call("agent.task.cancel", { id: task.id })).status).toBe(200);
  await until(
    async () => (await (await call("agent.task.get", { id: task.id })).json()) as any,
    (value) => value.status === "cancelled",
  );
  expect((await save()).status).toBe(200);
});
