import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { InstalledPanelApp } from "@cjhyy/code-shell-core";
import { createPanelAgentTaskHost } from "./agent-task-host.js";
import type { PanelAgentTaskView } from "./agent-task-service.js";
import { createPanelRuntime, panelWebCompatibility } from "./runtime.js";
import type { PanelSnapshot } from "./types.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Exercise the real worker bridge and runtime confirmation adapter without a model,
// network server, or a direct call to the host's private approvalRespond entry.
const WORKER = `
const {createInterface}=require('node:readline');
const fs=require('node:fs');
let run;
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const frame=JSON.parse(line);
 if(frame.method==='agent/run'){
  run=frame;
  const ask=run.params.task.startsWith('ask:');
  const panel=run.params.task==='panel';
  send({method:'agent/approvalRequest',params:{sessionId:run.params.sessionId,connectionId:'private-connection',generation:31,requestId:'private-approval',request:{toolName:ask?'__ask_user__':panel?'__panel_action__':'Bash',description:ask?'Enter a real text answer':'Run fixture operation',args:ask?{question:'Which option?',mode:run.params.task.slice(4)}:panel?{action:'invoke',panelId:'panel-app:synthetic-panel',toolName:'read_panel',arguments:{}}:{command:'fixture command'}}}});
 }
 if(frame.method==='agent/approve'){
  if(!frame.id||frame.params.connectionId!=='private-connection'||frame.params.generation!==31)return;
  fs.writeFileSync(process.env.PANEL_RUNTIME_APPROVAL_LOG,JSON.stringify(frame.params));
  send({id:frame.id,result:{ok:true}});
  send({method:'agent/approvalResolved',params:{sessionId:run.params.sessionId,requestId:'private-approval'}});
  const decision=frame.params.decision;
  send({id:run.id,result:{text:decision.answer??decision.reason??(decision.approved?'approved':'declined'),reason:'completed'}});
 }
 if(frame.method==='agent/cancel'){
  send({id:frame.id,result:{ok:true}});
  if(run)send({id:run.id,result:{text:'',reason:'aborted_streaming'}});
 }
});
`;

interface RuntimeEvent {
  id: number;
  event: string;
  payload: any;
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "panel-runtime-task-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace");
  const installPath = join(root, "installed");
  await Promise.all([mkdir(cwd), mkdir(join(installPath, "app"), { recursive: true })]);
  const workerEntryPath = join(root, "worker.cjs");
  const log = join(root, "approval.json");
  await Promise.all([
    writeFile(workerEntryPath, WORKER),
    writeFile(
      join(installPath, "app/index.html"),
      "<!doctype html><html><body>Fixture</body></html>",
    ),
  ]);
  const app: InstalledPanelApp = {
    id: "synthetic-panel",
    version: "1",
    packageDigest: "b".repeat(64),
    title: { default: "Synthetic panel" },
    entry: "app/index.html",
    icon: "panel",
    singleton: true,
    permissions: ["context.workspace", "agent.task"],
    agent: {
      tools: [
        {
          name: "read_panel",
          description: "Read panel",
          inputSchema: { type: "object", properties: {} },
          readOnly: true,
        },
      ],
      skills: [],
    },
    installPath,
    source: root,
    installedAt: "2026-10-15T00:00:00.000Z",
    lastUpdated: "2026-10-15T00:00:00.000Z",
  };
  const revision = "a".repeat(64);
  let taskHost!: ReturnType<typeof createPanelAgentTaskHost>;
  const runtime = createPanelRuntime({
    cwd,
    dataDir: join(root, "data"),
    host: "hub",
    ownerId: async () => "fixture-owner",
    isAuthorized: async () => true,
    listInstalled: async () => [structuredClone(app)],
    snapshot: async (): Promise<PanelSnapshot> => {
      const {
        installPath: _installPath,
        source: _source,
        installedAt: _installedAt,
        lastUpdated: _lastUpdated,
        ...publicApp
      } = app;
      return {
        workspace: cwd,
        hasProject: true,
        panels: [
          {
            ...publicApp,
            revision,
            bound: true,
            enabled: true,
            globalDisabled: false,
            updatable: false,
            source: { kind: "local", label: "Fixture" },
            compatibility: panelWebCompatibility(app),
          },
        ],
      };
    },
    createAgentTasks(hooks) {
      taskHost = createPanelAgentTaskHost({
        workerEntryPath,
        execPath: "node",
        buildEnv: () => ({ ...process.env, PANEL_RUNTIME_APPROVAL_LOG: log }),
        onPanelAction: hooks.onPanelAction,
        models: () => ({
          defaultModel: "fixture",
          models: [
            {
              id: "fixture",
              providerId: "openai",
              provider: "OpenAI",
              model: "fixture",
              label: "Fixture",
            },
          ],
        }),
      });
      return taskHost;
    },
  });
  cleanups.push(async () => {
    await runtime.close();
    await new Promise((done) => setTimeout(done, 30));
  });
  const api = async (path: string, method = "POST", value?: unknown) => {
    const request = Object.assign(
      Readable.from(value === undefined ? [] : [Buffer.from(JSON.stringify(value))]),
      {
        method,
        url: "/api/v1/panels/runtime/" + path,
        headers: { "content-type": "application/json", origin: "http://panel.fixture" },
        socket: {},
      },
    ) as unknown as IncomingMessage;
    let status = 0;
    let body = "";
    const response = {
      destroyed: false,
      writableEnded: false,
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        body = value;
        this.writableEnded = true;
      },
    } as unknown as ServerResponse;
    expect(await runtime.handle(request, response)).toBe(true);
    return { status, value: JSON.parse(body) };
  };
  const prepared = await api("prepare", "POST", { appId: app.id, revision });
  expect(prepared.status).toBe(200);
  const instanceId = prepared.value.instanceId as string;
  const events = async () => {
    const response = await api(`${instanceId}/events`, "GET");
    expect(response.status).toBe(200);
    return response.value.events as RuntimeEvent[];
  };
  const call = (method: string, params?: unknown) =>
    api(`${instanceId}/call`, "POST", { method, params });
  const waitEvent = async (event: string, after = 0) =>
    until(async () => (await events()).find((entry) => entry.id > after && entry.event === event));
  const confirm = async (event: RuntimeEvent, allowed: boolean) => {
    const response = await api(`${instanceId}/confirm`, "POST", {
      requestId: event.payload.requestId,
      allowed,
    });
    expect(response).toEqual({ status: 200, value: { accepted: true, allowed } });
  };
  const start = async (prompt: string) => {
    const before = (await events()).at(-1)?.id ?? 0;
    const pending = call("agent.task.start", {
      prompt,
      label: "Fixture task",
      toolNames: [prompt === "panel" ? "Panel" : "Bash"],
    });
    // This is the mandatory outer task-start confirmation, not a worker approval.
    const startConfirmation = await waitEvent("host.confirm", before);
    await confirm(startConfirmation, true);
    const response = await pending;
    expect(response.status).toBe(200);
    return { task: response.value as PanelAgentTaskView, startConfirmation };
  };
  const completed = (id: string) =>
    until(async () => {
      const response = await call("agent.task.get", { id });
      expect(response.status).toBe(200);
      return response.value.status === "completed"
        ? (response.value as PanelAgentTaskView)
        : undefined;
    });
  return { api, instanceId, log, taskHost, events, call, waitEvent, confirm, start, completed };
}

async function until<T>(check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (true) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for runtime worker fixture");
    await new Promise((done) => setTimeout(done, 50));
  }
}

for (const mode of ["sync", "async"]) {
  test(`Panel runtime rejects ${mode} AskUser without a boolean confirmation or private approval leak`, async () => {
    const f = await fixture();
    const { task, startConfirmation } = await f.start(`ask:${mode}`);
    const done = await f.completed(task.id);
    expect(done.result!.text).toMatch(/user\.ask.*not supported.*Panel agent task/);
    const decision = JSON.parse(await readFile(f.log, "utf8")).decision;
    expect(decision).toMatchObject({ approved: false, failure: "unavailable" });
    expect(decision.reason).toBe(done.result!.text);
    expect(decision.answer).toBeUndefined();
    const workerEvents = (await f.events()).filter((event) => event.id > startConfirmation.id);
    expect(workerEvents.some(({ event }) => event === "host.confirm")).toBe(false);
    expect(workerEvents.some(({ event }) => event.startsWith("agent.task.approval"))).toBe(false);
    expect(JSON.stringify(workerEvents)).not.toMatch(
      /private-approval|private-connection|__ask_user__/,
    );
    expect(f.taskHost.activeTaskCount()).toBe(0);
    const forged = await f.api(`${f.instanceId}/confirm`, "POST", {
      requestId: "private-approval",
      allowed: true,
    });
    expect(forged.status).toBe(400);
  });
}

for (const allowed of [true, false]) {
  test(`Panel runtime preserves ordinary worker approval through host.confirm (${allowed})`, async () => {
    const f = await fixture();
    const { task, startConfirmation } = await f.start("bash");
    const approval = await f.waitEvent("host.confirm", startConfirmation.id);
    expect(approval.payload).toMatchObject({ title: "批准 Bash", body: "Run fixture operation" });
    expect(approval.payload.requestId).not.toBe("private-approval");
    await f.confirm(approval, allowed);
    const done = await f.completed(task.id);
    expect(done.result!.text).toBe(allowed ? "approved" : "Declined by user");
    expect(JSON.parse(await readFile(f.log, "utf8"))).toMatchObject({
      connectionId: "private-connection",
      generation: 31,
      requestId: "private-approval",
      decision: allowed
        ? { approved: true, scope: "once" }
        : { approved: false, reason: "Declined by user" },
    });
    expect((await f.events()).some(({ event }) => event === "agent.task.approvalRequested")).toBe(
      false,
    );
    expect(f.taskHost.activeTaskCount()).toBe(0);
  });
}

test("Panel runtime preserves installed Panel callbacks without generic approval", async () => {
  const f = await fixture();
  expect((await f.call("tools.register", { name: "read_panel" })).status).toBe(200);
  const { task, startConfirmation } = await f.start("panel");
  const invocation = await f.waitEvent("tools.invoke", startConfirmation.id);
  expect(invocation.payload).toMatchObject({ toolName: "read_panel", args: {} });
  const reply = await f.api(`${f.instanceId}/tool-results`, "POST", {
    requestId: invocation.payload.requestId,
    result: { saved: true },
  });
  expect(reply.status).toBe(200);
  const done = await f.completed(task.id);
  expect(JSON.parse(done.result!.text)).toMatchObject({
    ok: true,
    panelId: "panel-app:synthetic-panel",
    toolName: "read_panel",
    result: { saved: true },
  });
  const workerEvents = (await f.events()).filter((event) => event.id > startConfirmation.id);
  expect(workerEvents.some(({ event }) => event === "host.confirm")).toBe(false);
  expect(workerEvents.some(({ event }) => event.startsWith("agent.task.approval"))).toBe(false);
  expect(JSON.stringify(workerEvents)).not.toMatch(/private-approval|__panel_action__/);
  expect(f.taskHost.activeTaskCount()).toBe(0);
});
