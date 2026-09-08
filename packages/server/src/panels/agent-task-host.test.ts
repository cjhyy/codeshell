import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPanelAgentTaskHost,
  type PanelAgentTaskHost,
  type PanelAgentTaskScope,
} from "./agent-task-host.js";
import type { PanelAgentTaskView } from "./agent-task-service.js";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});
const catalog = {
  defaultModel: "fixture",
  models: [
    { id: "fixture", providerId: "openai", provider: "OpenAI", model: "fixture", label: "Fixture" },
  ],
};

const WORKER = `
const {createInterface}=require('node:readline');
const fs=require('node:fs');
let run;
const send=(value)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const frame=JSON.parse(line);
 if(frame.method==='agent/run'){
  run=frame; fs.writeFileSync(process.env.PANEL_TASK_FIXTURE_LOG,JSON.stringify(frame.params));
  send({method:'agent/streamEvent',params:{sessionId:run.params.sessionId,event:{type:'stream_request_start'}}});
  if(run.params.task==='approve'||run.params.task==='panel')send({method:'agent/approvalRequest',params:{sessionId:run.params.sessionId,connectionId:'fixture-owner',generation:17,requestId:'ask-1',request:{toolName:run.params.task==='panel'?'__panel_action__':'Bash',description:'Write fixture file',args:run.params.task==='panel'?{action:'invoke',panelId:'sample',toolName:'refresh'}:{command:'echo hello'}}}});
  else if(run.params.task!=='hold')send({id:run.id,result:{text:'fixture result',reason:'completed',usage:{promptTokens:2,completionTokens:3,totalTokens:5}}});
 }
 if(frame.method==='agent/approve'){
  if(frame.params.connectionId!=='fixture-owner'||frame.params.generation!==17)return send({id:frame.id,error:{message:'wrong approval route'}});
  fs.writeFileSync(process.env.PANEL_TASK_FIXTURE_LOG+'.approval',JSON.stringify(frame.params));
  send({id:frame.id,result:{ok:true}});
  send({id:run.id,result:{text:frame.params.decision.approved?'approved':'declined',reason:'completed'}});
 }
 if(frame.method==='agent/cancel'){
  send({id:frame.id,result:{ok:true}});
  if(run)send({id:run.id,result:{text:'',reason:'aborted_streaming'}});
 }
});
`;

async function fixture(options: Parameters<typeof createPanelAgentTaskHost>[0] = {}) {
  const root = await mkdtemp(join(tmpdir(), "panel-task-"));
  const workerEntryPath = join(root, "worker.cjs");
  const log = join(root, "run.json");
  await writeFile(workerEntryPath, WORKER);
  const events: Array<{ event: string; payload: any }> = [];
  let authorized = true;
  const scope: PanelAgentTaskScope = {
    instanceId: "instance-a",
    ownerId: "owner-a",
    appId: "sample",
    appTitle: "Sample",
    cwd: root,
    projectPath: root,
    permissions: ["agent.task"],
    availableSkills: ["sample:setup"],
    isAuthorized: async () => authorized,
    emit: (event, payload) => events.push({ event, payload }),
  };
  const host = createPanelAgentTaskHost({
    workerEntryPath,
    models: () => catalog,
    buildEnv: () => ({ ...process.env, PANEL_TASK_FIXTURE_LOG: log }),
    authorizationPollMs: 10,
    ...options,
  });
  disposals.push(async () => {
    host.close();
    await new Promise((done) => setTimeout(done, 40));
    await rm(root, { recursive: true, force: true });
  });
  return {
    host,
    scope,
    root,
    log,
    events,
    revoke: () => {
      authorized = false;
    },
  };
}

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for task fixture");
    await new Promise((done) => setTimeout(done, 10));
  }
}

async function task(host: PanelAgentTaskHost, scope: PanelAgentTaskScope, id: string) {
  return (await host.call(scope, "agent.task.get", { id })) as PanelAgentTaskView;
}

test("uses a real independent subprocess with bounded model, tools and Skills", async () => {
  const f = await fixture();
  expect(await f.host.call(f.scope, "agent.task.models")).toEqual(catalog);
  const started = (await f.host.call(f.scope, "agent.task.start", {
    prompt: "run",
    label: "Run",
    toolNames: ["Bash", "Read"],
    skill: "sample:setup",
  })) as PanelAgentTaskView;
  await until(async () => (await task(f.host, f.scope, started.id)).status === "completed");
  expect(await task(f.host, f.scope, started.id)).toMatchObject({
    result: { text: "fixture result", usage: { totalTokens: 5 } },
  });
  const run = JSON.parse(await readFile(f.log, "utf8"));
  expect(run).toMatchObject({
    cwd: f.root,
    permissionMode: "default",
    ephemeral: true,
    behaviorMode: "isolatedTask",
    model: "fixture",
    toolAllowlist: ["Bash", "Read", "Skill"],
    skillAllowlist: ["sample:setup"],
    maxTurns: 8,
  });
  expect(f.events.some(({ event }) => event === "agent.task.changed")).toBe(true);
  expect(f.host.activeTaskCount()).toBe(0);
});

test("requires a scoped one-shot tool approval and preserves the worker route", async () => {
  const f = await fixture();
  const started = (await f.host.call(f.scope, "agent.task.start", {
    prompt: "approve",
    label: "Approve",
    toolNames: ["Bash"],
  })) as PanelAgentTaskView;
  await until(() => f.events.some(({ event }) => event === "agent.task.approvalRequested"));
  const request = f.events.find(({ event }) => event === "agent.task.approvalRequested")!.payload;
  expect(request).toMatchObject({ taskId: started.id, toolName: "Bash", requestId: "ask-1" });
  await expect(
    f.host.call({ ...f.scope, ownerId: "attacker" }, "agent.task.approvalRespond", {
      ...request,
      approved: true,
    }),
  ).rejects.toThrow(/owner/);
  await expect(
    f.host.call(f.scope, "agent.task.approvalRespond", {
      ...request,
      taskId: "other-task",
      approved: true,
    }),
  ).rejects.toThrow(/approval/);
  expect(
    await f.host.call(f.scope, "agent.task.approvalRespond", { ...request, approved: true }),
  ).toBe(true);
  await expect(
    f.host.call(f.scope, "agent.task.approvalRespond", { ...request, approved: true }),
  ).rejects.toThrow(/approval/);
  await until(async () => (await task(f.host, f.scope, started.id)).status === "completed");
  expect(JSON.parse(await readFile(`${f.log}.approval`, "utf8"))).toMatchObject({
    connectionId: "fixture-owner",
    generation: 17,
    decision: { approved: true, scope: "once" },
  });
});

test("routes internal Panel actions through the host callback without UI self-approval", async () => {
  const calls: unknown[] = [];
  const f = await fixture({
    onPanelAction: async (scope, args) => {
      calls.push([scope.appId, args]);
      return { ok: true, result: "refreshed" };
    },
  });
  const started = (await f.host.call(f.scope, "agent.task.start", {
    prompt: "panel",
    label: "Panel",
    toolNames: ["Panel"],
  })) as PanelAgentTaskView;
  await until(async () => (await task(f.host, f.scope, started.id)).status === "completed");
  expect(calls).toEqual([["sample", { action: "invoke", panelId: "sample", toolName: "refresh" }]]);
  expect(f.events.some(({ event }) => event === "agent.task.approvalRequested")).toBe(false);
  expect(JSON.parse(await readFile(`${f.log}.approval`, "utf8")).decision).toEqual({
    approved: true,
    answer: '{"ok":true,"result":"refreshed"}',
  });
});

test("revocation terminates tasks and prevents another instance from reading them", async () => {
  const f = await fixture();
  const started = (await f.host.call(f.scope, "agent.task.start", {
    prompt: "hold",
    label: "Hold",
  })) as PanelAgentTaskView;
  await until(async () => !!(await readFile(f.log, "utf8").catch(() => "")));
  await expect(
    f.host.call({ ...f.scope, instanceId: "instance-b" }, "agent.task.get", { id: started.id }),
  ).rejects.toThrow(/not found/);
  f.revoke();
  await until(() => f.host.activeTaskCount() === 0);
  await expect(f.host.call(f.scope, "agent.task.list")).rejects.toThrow(/authorized/);
});

test("cancellation while model selection is pending never starts a worker", async () => {
  let resolveModels!: (value: typeof catalog) => void;
  const waiting = new Promise<typeof catalog>((resolve) => {
    resolveModels = resolve;
  });
  const f = await fixture({ models: () => waiting, maxConcurrentTasks: 1 });
  const started = (await f.host.call(f.scope, "agent.task.start", {
    prompt: "hold",
    label: "Hold",
  })) as PanelAgentTaskView;
  expect(f.host.activeTaskCount()).toBe(1);
  await expect(
    f.host.call(f.scope, "agent.task.start", { prompt: "another", label: "Another" }),
  ).rejects.toThrow(/Too many/);
  await f.host.call(f.scope, "agent.task.cancel", { id: started.id });
  resolveModels(catalog);
  await until(async () => (await task(f.host, f.scope, started.id)).status === "cancelled");
  expect(await readFile(f.log, "utf8").catch(() => null)).toBeNull();
});

test("rejects missing model, unbundled Skills and delegation tools without fake results", async () => {
  const f = await fixture({ models: () => ({ models: [] }) });
  await expect(
    f.host.call(f.scope, "agent.task.start", { prompt: "run", label: "Run", toolNames: ["Task"] }),
  ).rejects.toThrow(/tool/);
  await expect(
    f.host.call(f.scope, "agent.task.start", {
      prompt: "run",
      label: "Run",
      skill: "other:private",
    }),
  ).rejects.toThrow(/bundled/);
  const started = (await f.host.call(f.scope, "agent.task.start", {
    prompt: "run",
    label: "Run",
  })) as PanelAgentTaskView;
  await until(async () => (await task(f.host, f.scope, started.id)).status === "failed");
  expect((await task(f.host, f.scope, started.id)).error).toContain("模型");
  expect(await readFile(f.log, "utf8").catch(() => null)).toBeNull();
});
