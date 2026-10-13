import assert from "node:assert/strict";
const cases: Array<{ name: string; run: () => Promise<void> }> = [];
const test = (name: string, run: () => Promise<void>) => cases.push({ name, run });
let cleanupAfterCase = async () => {};
const afterEach = (run: () => Promise<void>) => {
  cleanupAfterCase = run;
};
function expect(value: any) {
  return {
    toBe: (expected: unknown) => assert.equal(value, expected),
    toEqual: (expected: unknown) => assert.deepEqual(value, expected),
    toBeString: () => assert.equal(typeof value, "string"),
    toBeNumber: () => assert.equal(typeof value, "number"),
    toBeUndefined: () => assert.equal(value, undefined),
    toHaveLength: (length: number) => assert.equal(value.length, length),
    toContain: (part: string) => assert.ok(value.includes(part)),
    not: { toMatch: (pattern: RegExp) => assert.doesNotMatch(value, pattern) },
    rejects: {
      toMatchObject: (expected: Record<string, unknown>) => assert.rejects(value, expected),
      toThrow: (message: string) =>
        assert.rejects(value, (error: any) => error.message.includes(message)),
    },
  };
}
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectRuntimeProvider } from "../../../server/src/project-runtime/types";
import type { HeadlessServer } from "../../../server/src/serve/headless-server";
import type { CloudEnvironmentEvent, CloudConnectionStatus } from "../shared/cloud-environment";
import { CloudEnvironmentService } from "./cloud-environment-service";

const allowedOrigins = (globalThis as any).__codeshellCloudFixtureOrigins as Set<string>;
if (!(allowedOrigins instanceof Set))
  throw new Error("Native fixture requires the exact-origin network preload");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const WORKER = `
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const runs = new Map();
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
const notify = (method,params) => send({method,params});
readline.createInterface({input:process.stdin}).on('line',line=>{
  const msg=JSON.parse(line); const p=msg.params||{};
  if(msg.method==='agent/run') {
    runs.set(p.sessionId,msg);
    const dir=path.join(process.env.CODE_SHELL_DATA_ROOT,'sessions',p.sessionId);
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify({sessionId:p.sessionId,cwd:p.cwd,startedAt:123,status:'active',model:'fixture',turnCount:1}));
    fs.writeFileSync(path.join(dir,'transcript.jsonl'),JSON.stringify({id:p.clientMessageId,type:'message',timestamp:123,turnNumber:0,data:{role:'user',content:p.task,clientMessageId:p.clientMessageId}})+'\\n');
    notify('agent/runAccepted',{requestId:msg.id,sessionId:p.sessionId,clientMessageId:p.clientMessageId});
    notify('agent/streamEvent',{sessionId:p.sessionId,event:{type:'text_delta',text:'remote reply'}});
    notify('agent/approvalRequest',{sessionId:p.sessionId,requestId:'approve-'+p.sessionId,request:{tool:'Shell',args:{command:'echo fixture'}},connectionId:'remote-worker',generation:1});
  } else if(msg.method==='agent/approve'||msg.method==='agent/cancel') {
    send({id:msg.id,result:{ok:true}});
    const run=runs.get(p.sessionId);
    if(run) {
      runs.delete(p.sessionId);
      notify('agent/approvalResolved',{sessionId:p.sessionId,requestId:'approve-'+p.sessionId});
      notify('agent/streamEvent',{sessionId:p.sessionId,event:{type:'turn_complete'}});
      send({id:run.id,result:{echo:run.params,cancelled:msg.method==='agent/cancel'}});
    }
  } else if(msg.id!==undefined) send({id:msg.id,result:{ok:true}});
});
`;

async function fixture() {
  const [
    { startProjectControlServer },
    { startHeadlessServer },
    { HubAuthStore },
    { ProjectRuntimeStore },
  ] = await Promise.all([
    import("../../../server/src/project-runtime/control-server"),
    import("../../../server/src/serve/headless-server"),
    import("../../../server/src/hub/auth-store"),
    import("./project-runtime-store"),
  ]);
  const root = mkdtempSync(join(tmpdir(), "cs-native-cloud-"));
  const worker = join(root, "fixture-worker.cjs");
  writeFileSync(worker, WORKER);
  const runtimes = new Map<string, HeadlessServer>();
  const provider: ProjectRuntimeProvider = {
    availability: async () => ({ available: true }),
    async ensure(record, { publicOrigin }) {
      let inner = runtimes.get(record.id);
      if (!inner) {
        const workspace = join(root, record.id, "workspace");
        const dataDir = join(root, record.id, "data");
        mkdirSync(workspace, { recursive: true });
        const auth = new HubAuthStore({ dataDir });
        const token = auth.initialize()!;
        await auth.setup({
          token,
          username: record.runtimeUsername,
          password: record.runtimePassword,
        });
        inner = await startHeadlessServer({
          host: "127.0.0.1",
          port: 0,
          cwd: workspace,
          dataDir,
          workerDataRoot: join(dataDir, "worker"),
          authMode: "hub",
          publicOrigin,
          workerEntryPath: worker,
          execPath: process.execPath,
        });
        allowedOrigins.add(inner.url);
        runtimes.set(record.id, inner);
      }
      return {
        url: inner.url,
        username: record.runtimeUsername,
        password: record.runtimePassword,
        generation: record.generation,
      };
    },
    async status(record) {
      return runtimes.has(record.id)
        ? { state: "running", url: runtimes.get(record.id)!.url }
        : { state: "stopped" };
    },
    async stop(record) {
      await runtimes.get(record.id)?.close();
      runtimes.delete(record.id);
    },
    close: async () => {},
  };
  const control = await startProjectControlServer({
    host: "127.0.0.1",
    port: 0,
    dataDir: join(root, "control"),
    provider,
  });
  allowedOrigins.add(control.url);
  const setup = await fetch(control.url + "/api/v1/auth/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: control.url },
    body: JSON.stringify({
      token: control.bootstrapToken,
      username: "alice",
      password: "Native-test-password-23940",
    }),
  });
  expect(setup.status).toBe(200);
  const adminCookie = setup.headers.get("set-cookie")!.split(";", 1)[0]!;
  await setup.arrayBuffer();
  const admin = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(control.url + path, {
      method,
      headers: { Cookie: adminCookie, Origin: control.url, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.ok).toBe(true);
    return response.json() as Promise<any>;
  };
  const { project } = await admin("/api/v1/projects", "POST", { name: "Existing cloud project" });
  const localProjectId = randomUUID();
  const store = new ProjectRuntimeStore(join(root, "native-bindings.json"));
  let cookie: string | undefined;
  let ownerAlive = true;
  let localProjectAlive = true;
  let configurationOverride: ((value: any) => unknown) | undefined;
  const events: CloudEnvironmentEvent[] = [];
  const statuses: CloudConnectionStatus[] = [];
  const httpPaths: string[] = [];
  const service = new CloudEnvironmentService({
    store,
    assertLocalProject: async (id) => {
      if (id !== localProjectId || !localProjectAlive) throw new Error("local project not found");
    },
    ownerAlive: (owner) => ownerAlive && owner === 1,
    retryDelayMs: 10,
    onEvent: (owner, event) => {
      expect(owner).toBe(1);
      events.push(event);
    },
    onStatus: (_owner, status) => statuses.push(status),
    transport: {
      async fetch(origin, path, init) {
        expect(origin).toBe(control.url);
        expect(init.redirect).toBe("error");
        expect(init.credentials).toBe("include");
        httpPaths.push(path);
        const response = await fetch(origin + path, {
          ...init,
          headers: { ...init.headers, ...(cookie ? { Cookie: cookie } : {}) },
        });
        const received = response.headers.get("set-cookie");
        if (received) cookie = received.split(";", 1)[0]!;
        if (configurationOverride && path.endsWith("/api/v1/configuration"))
          return Response.json(configurationOverride(await response.json()));
        return response;
      },
      async cookie(origin) {
        expect(origin).toBe(control.url);
        return cookie;
      },
    },
  });
  cleanups.push(async () => {
    service.close();
    await control.close();
    for (const runtime of runtimes.values()) await runtime.close();
    rmSync(root, { recursive: true, force: true });
  });
  const login = () =>
    service.login({
      origin: control.url,
      username: "alice",
      password: "Native-test-password-23940",
    });
  const bind = async () => {
    const discovery = await login();
    return service.bind({
      localProjectId,
      origin: control.url,
      environmentId: discovery.environment!.id,
      remoteProjectId: project.id,
    });
  };
  return {
    root,
    control,
    service,
    store,
    project,
    localProjectId,
    events,
    statuses,
    httpPaths,
    admin,
    login,
    bind,
    revokeOwner: () => {
      ownerAlive = false;
    },
    revokeLocalProject: () => {
      localProjectAlive = false;
    },
    overrideConfiguration: (replacement?: (value: any) => unknown) => {
      configurationOverride = replacement;
    },
  };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("fixture event timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("native login binds an existing project and runs, streams, approves, stops and reads remote history", async () => {
  const f = await fixture();
  expect(await f.service.discover({ origin: f.control.url })).toEqual({
    origin: f.control.url,
    initialized: true,
    authenticated: false,
  });
  const binding = await f.bind();
  expect(JSON.stringify(binding)).not.toMatch(/password|cs_hub_session|runtimeUsername/);
  await expect(f.service.connect(1, { bindingId: binding.id })).rejects.toMatchObject({
    reason: "project-stopped",
  });
  expect((await f.service.start({ bindingId: binding.id })).status).toBe("running");
  const connection = await f.service.connect(1, { bindingId: binding.id });
  expect(connection.configuration.workspace.path).toContain("workspace");
  const attachment = await f.service.upload(1, {
    connectionId: connection.connectionId,
    sessionId: "remote-session.v1",
    name: "fixture.txt",
    mimeType: "text/plain",
    bytes: new TextEncoder().encode("Only these selected bytes reach the remote project."),
  });
  expect(attachment.name).toBe("fixture.txt");
  const params = {
    sessionId: "remote-session.v1",
    task: "Do remote work",
    clientMessageId: "submit-1",
    model: "fixture",
  };
  const run = f.service.request(1, {
    connectionId: connection.connectionId,
    method: "agent/run",
    params: { ...params, uploadIds: [attachment.id] },
  });
  await until(() => f.events.some((event) => event.method === "agent/approvalRequest"));
  const streamed = f.events.find((event) => event.method === "agent/streamEvent")!;
  expect(streamed.projectId).toBe(binding.remoteProjectId);
  expect(streamed.environmentId).toBe(binding.environmentId);
  expect(streamed.params.hubEpoch).toBeString();
  expect(streamed.params.hubSequence).toBeNumber();
  await f.service.request(1, {
    connectionId: connection.connectionId,
    method: "agent/approve",
    params: {
      sessionId: params.sessionId,
      requestId: "approve-remote-session.v1",
      decision: { approved: true },
    },
  });
  const result = (await run) as any;
  expect(result.echo.task).toBe(params.task);
  expect(result.echo.cwd).toBe(connection.configuration.workspace.path);
  expect(result.echo.projectId).toBeUndefined();
  expect(result.echo.attachments.length).toBe(1);
  const detail = (await f.service.request(1, {
    connectionId: connection.connectionId,
    method: "agent/query",
    params: { type: "session_detail", sessionId: params.sessionId, outputRecovery: true },
  })) as any;
  expect(detail.data.state.sessionId).toBe(params.sessionId);
  expect(detail.data.running).toBe(false);
  const listing = (await f.service.listSessions(1, {
    connectionId: connection.connectionId,
  })) as any;
  expect(listing.sessions.some((session: any) => session.sessionId === params.sessionId)).toBe(
    true,
  );
  const next = f.service.request(1, {
    connectionId: connection.connectionId,
    method: "agent/run",
    params: { ...params, clientMessageId: "submit-2" },
  });
  await until(
    () => f.events.filter((event) => event.method === "agent/approvalRequest").length === 2,
  );
  await f.service.request(1, {
    connectionId: connection.connectionId,
    method: "agent/cancel",
    params: { sessionId: params.sessionId },
  });
  expect(((await next) as any).cancelled).toBe(true);
  expect(
    f.httpPaths.some((path) => path === `/p/${binding.remoteProjectId}/api/v1/configuration`),
  ).toBe(true);
  expect(f.statuses.some((status) => status.status === "connected")).toBe(true);
});

test("remote identity, local project authority, window ownership and method policy fail closed", async () => {
  const f = await fixture();
  const discovery = await f.login();
  await expect(
    f.service.bind({
      localProjectId: f.localProjectId,
      origin: f.control.url,
      environmentId: randomUUID(),
      remoteProjectId: f.project.id,
    }),
  ).rejects.toMatchObject({ reason: "identity-mismatch" });
  await expect(
    f.service.bind({
      localProjectId: randomUUID(),
      origin: f.control.url,
      environmentId: discovery.environment!.id,
      remoteProjectId: f.project.id,
    }),
  ).rejects.toThrow("local project not found");
  expect(f.store.list()).toHaveLength(0);
  const binding = await f.bind();
  await f.service.start({ bindingId: binding.id });
  f.overrideConfiguration((configuration) => ({ ...configuration, connections: [null] }));
  await expect(f.service.connect(1, { bindingId: binding.id })).rejects.toThrow("无效的模型配置");
  f.overrideConfiguration((configuration) => ({
    ...configuration,
    apiKey: "must-not-cross-native-boundary",
  }));
  const connection = await f.service.connect(1, { bindingId: binding.id });
  expect(JSON.stringify(connection.configuration)).not.toMatch(/must-not-cross-native-boundary/);
  await expect(
    f.service.request(2, {
      connectionId: connection.connectionId,
      method: "agent/query",
      params: { type: "sessions" },
    }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    f.service.request(1, {
      connectionId: connection.connectionId,
      method: "agent/run",
      params: { sessionId: "s", task: "x", clientMessageId: "i", cwd: "/local" },
    }),
  ).rejects.toMatchObject({ kind: "not-sent", reason: "invalid-input" });
  await expect(
    f.service.request(1, {
      connectionId: connection.connectionId,
      method: "agent/configure",
      params: {},
    }),
  ).rejects.toMatchObject({ kind: "not-sent" });
  f.revokeOwner();
  await expect(
    f.service.request(1, {
      connectionId: connection.connectionId,
      method: "agent/query",
      params: { type: "sessions" },
    }),
  ).rejects.toMatchObject({ status: 403 });
});

test("lost replies stay uncertain and reconnect never resends a run", async () => {
  const f = await fixture();
  const binding = await f.bind();
  await f.service.start({ bindingId: binding.id });
  const connection = await f.service.connect(1, { bindingId: binding.id });
  const run = f.service.request(1, {
    connectionId: connection.connectionId,
    method: "agent/run",
    params: {
      sessionId: "uncertain",
      task: "once",
      clientMessageId: "intent-once",
      model: "fixture",
    },
  });
  // Observe the rejection before deliberately closing the transport.
  const rejected = expect(run).rejects.toMatchObject({ kind: "transport" });
  await until(() => f.events.some((event) => event.method === "agent/approvalRequest"));
  const socket = (f.service as any).connections.get(connection.connectionId).socket;
  socket.terminate();
  await rejected;
  await until(() => f.statuses.filter((status) => status.status === "connected").length === 2);
  const detail = (await f.service.request(1, {
    connectionId: connection.connectionId,
    method: "agent/query",
    params: { type: "session_detail", sessionId: "uncertain" },
  })) as any;
  expect(detail.data.running).toBe(true);
  expect(f.events.filter((event) => event.method === "agent/runAccepted")).toHaveLength(1);
  await f.service.request(1, {
    connectionId: connection.connectionId,
    method: "agent/cancel",
    params: { sessionId: "uncertain" },
  });
  f.revokeLocalProject();
  (f.service as any).connections.get(connection.connectionId).socket.terminate();
  await until(() => f.statuses.some((status) => status.status === "closed"));
  const closed = f.statuses.find((status) => status.status === "closed")!;
  expect(closed.error).toBe("local project not found");
});

for (const entry of cases) {
  try {
    await entry.run();
  } catch (error) {
    console.error(entry.name);
    throw error;
  } finally {
    await cleanupAfterCase();
  }
}
process.stdout.write(JSON.stringify({ passed: cases.length }));
