import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { CONTRACTS } from "@cjhyy/code-shell-core";
import { startHeadlessServer, type HeadlessServer } from "./headless-server.js";

const PASSCODE = "serve-unsupported-passcode";

// Stand-in worker. agent/run's task names what to emit: a loopback toolName
// becomes an approval request; a desktop/* method becomes a worker → host
// request; "env" reports host-only switches the worker inherited. Whatever the
// host answers is echoed back as the run result.
const WORKER = `
const {createInterface}=require('node:readline');
const send=(v)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');
const runs=new Map();
createInterface({input:process.stdin}).on('line',line=>{
 const frame=JSON.parse(line);
 if(frame.method==='agent/run'){
  const {sessionId,task}=frame.params;
  if(task==='env'){send({id:frame.id,result:{env:{batch:process.env.CODE_SHELL_OPERATION_BATCH_ACCESS??null,signing:process.env.CODE_SHELL_MODEL_REQUEST_SIGNING??null}}});return;}
  if(task.startsWith('desktop/')){runs.set('host-'+frame.id,frame);send({id:'host-'+frame.id,method:task,params:{prompt:'secret prompt'}});return;}
  runs.set(sessionId,frame);
  send({method:'agent/approvalRequest',params:{sessionId,requestId:'req-'+frame.id,connectionId:'c1',generation:1,request:{toolName:task,description:'x',riskLevel:'low',args:{}}}});
 }else if(frame.method==='agent/approve'){
  send({id:frame.id,result:{accepted:true}});
  const run=runs.get(frame.params.sessionId);
  if(run){runs.delete(frame.params.sessionId);send({id:run.id,result:{decision:frame.params.decision}});}
 }else if(frame.method===undefined&&frame.id!==undefined){
  const run=runs.get(frame.id);
  if(run){runs.delete(frame.id);send({id:run.id,result:{hostReply:frame}});}
 }else if(frame.id!==undefined)send({id:frame.id,result:{ok:true}});
});
`;

const roots: string[] = [];
const servers: HeadlessServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function startServer(): Promise<HeadlessServer> {
  const root = mkdtempSync(join(tmpdir(), "serve-unsupported-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  const staticDir = join(root, "static");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>t</title>");
  const workerEntryPath = join(root, "worker.cjs");
  writeFileSync(workerEntryPath, WORKER);
  const server = await startHeadlessServer({
    host: "127.0.0.1",
    port: 0,
    cwd,
    dataDir: join(root, "serve-data"),
    workerEntryPath,
    sessionRootDir: join(root, "sessions"),
    execPath: process.execPath,
    staticRootDir: staticDir,
    passcode: PASSCODE,
  });
  servers.push(server);
  return server;
}

async function connect(server: HeadlessServer) {
  const ws = new WebSocket(`${server.url.replace(/^http/, "ws")}/ws`, {
    headers: { "x-access-passcode": PASSCODE },
  });
  sockets.push(ws);
  ws.on("error", () => {});
  const received: Array<Record<string, any>> = [];
  ws.on("message", (data) => received.push(JSON.parse(String(data))));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  async function run(sessionId: string, task: string) {
    const id = `run-${sessionId}`;
    ws.send(
      JSON.stringify({ jsonrpc: "2.0", id, method: "agent/run", params: { sessionId, task } }),
    );
    const deadline = Date.now() + 5_000;
    for (;;) {
      const reply = received.find((message) => message.id === id);
      if (reply) return reply;
      if (Date.now() > deadline) throw new Error(`no reply for ${id}`);
      await new Promise((done) => setTimeout(done, 10));
    }
  }
  return { received, run };
}

test("serve answers Desktop-only loopbacks with unsupported instead of broadcasting them", async () => {
  const client = await connect(await startServer());
  for (const [toolName, capability] of [
    ["__browser_action__", "browser"],
    ["__credential_action__", "credential.browserCookie"],
    ["__workspace_action__", "workspace.switch"],
  ] as const) {
    const reply = await client.run(
      `session-unsupported-${capability.replace(/\./g, "-")}`,
      toolName,
    );
    expect(reply.error).toBeUndefined();
    expect(reply.result.decision.approved).toBe(true);
    expect(JSON.parse(reply.result.decision.answer)).toMatchObject({
      ok: false,
      failure: "unsupported",
      capability,
    });
  }
  expect(client.received.some((message) => message.method === "agent/approvalRequest")).toBe(false);
});

test("serve rejects desktop/* worker requests immediately with a typed error", async () => {
  const client = await connect(await startServer());
  const reply = await client.run("session-unsupported-automation", "desktop/automationCreate");
  expect(reply.result.hostReply.error).toEqual({
    code: -32601,
    message: "desktop/automationCreate is not supported by this host (headless serve)",
    data: { failure: "unsupported", capability: "desktop/automationCreate" },
  });
});

test("passcode-mode health reports the contract table", async () => {
  const server = await startServer();
  expect(await (await fetch(server.url + "/health")).json()).toEqual({
    status: "ok",
    mode: "passcode",
    contracts: JSON.parse(JSON.stringify(CONTRACTS)),
  });
});

test("passcode serve has no Panel runtime, so Panel actions are unsupported too", async () => {
  const client = await connect(await startServer());
  const reply = await client.run("session-unsupported-panel", "__panel_action__");
  expect(JSON.parse(reply.result.decision.answer)).toMatchObject({
    ok: false,
    failure: "unsupported",
    capability: "panel",
  });
});

test("worker → host authority requests never reach a Web tab", async () => {
  const client = await connect(await startServer());
  await client.run("session-unsupported-leak", "desktop/automationCreate");
  expect(
    client.received.some(
      (message) =>
        message.method === "desktop/automationCreate" ||
        JSON.stringify(message).includes("secret prompt"),
    ),
  ).toBe(false);
});

test("serve workers do not inherit host-only IPC switches", async () => {
  const previous = {
    batch: process.env.CODE_SHELL_OPERATION_BATCH_ACCESS,
    signing: process.env.CODE_SHELL_MODEL_REQUEST_SIGNING,
  };
  process.env.CODE_SHELL_OPERATION_BATCH_ACCESS = "host";
  process.env.CODE_SHELL_MODEL_REQUEST_SIGNING = "host";
  try {
    const client = await connect(await startServer());
    const reply = await client.run("session-unsupported-env", "env");
    expect(reply.result.env).toEqual({ batch: null, signing: null });
  } finally {
    if (previous.batch === undefined) delete process.env.CODE_SHELL_OPERATION_BATCH_ACCESS;
    else process.env.CODE_SHELL_OPERATION_BATCH_ACCESS = previous.batch;
    if (previous.signing === undefined) delete process.env.CODE_SHELL_MODEL_REQUEST_SIGNING;
    else process.env.CODE_SHELL_MODEL_REQUEST_SIGNING = previous.signing;
  }
});
