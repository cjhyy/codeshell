import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveWritePolicy, type CronRunRequest } from "@cjhyy/code-shell-core/internal";
import { WorkerBridgeCore } from "../worker-bridge-core.js";
import { createHubAutomationWorker } from "./automation-worker.js";
import {
  HubAutomationCancelledError,
  HubAutomationUncertainError,
} from "../panels/hub-automations.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const script = `
const {createInterface}=require('node:readline');
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
let running; const approvals=[];
createInterface({input:process.stdin}).on('line',line=>{
 const frame=JSON.parse(line), params=frame.params||{};
 if(frame.method==='agent/run'){
  running=frame;
  if(params.task==='crash'){process.exit(7);return;}
  if(params.task==='silent'){process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),150));send({method:'test/silent-ready'});return;}
  send({method:'agent/runAccepted',params:{requestId:frame.id,sessionId:params.sessionId}});
  if(params.task==='hold')return;
  const approval={method:'agent/approvalRequest',params:{sessionId:params.sessionId,requestId:'approval-1',connectionId:'worker-route',generation:42,request:{toolName:params.task==='internal'?'__panel_action__':'Write',args:{file_path:'proof.txt'},description:'test approval'}}};
  send(approval);send(approval);
 } else if(frame.method==='agent/approve'){
  approvals.push(params);send({id:frame.id,result:{ok:true}});
  send({id:running.id,result:{reason:'completed'}});running=undefined;
 } else if(frame.method==='agent/cancel'){
  send({id:frame.id,result:{ok:true}});
  setTimeout(()=>{if(running){send({id:running.id,result:{reason:'aborted_streaming'}});running=undefined;}},80);
 } else if(frame.method==='test/state')send({id:frame.id,result:{approvals,run:running?.params}});
});
`;
function fixture(timeout = 5000) {
  const root = mkdtempSync(join(tmpdir(), "automation-worker-"));
  const file = join(root, "worker.cjs");
  writeFileSync(file, script);
  let held = false,
    released = 0,
    ready = false;
  const bridge = new WorkerBridgeCore({
    entryPath: file,
    execPath: "node",
    fallbackCwd: () => root,
  });
  const worker = createHubAutomationWorker({
    bridge,
    cwd: root,
    admissionTimeoutMs: timeout,
    model: () => "fixture",
    reserve: () => {
      if (held) throw Error("busy");
      held = true;
      return () => {
        held = false;
        released++;
      };
    },
  });
  bridge.subscribeLines((line) => {
    const message = JSON.parse(line);
    if (message.method === "agent/approvalRequest") worker.handleApproval(message.params);
    if (message.method === "test/silent-ready") ready = true;
  });
  cleanup.push(async () => {
    await bridge.stopAndWait();
    rmSync(root, { recursive: true, force: true });
  });
  const request = (prompt: string, signal?: AbortSignal): CronRunRequest => ({
    job: {
      id: "1",
      name: "test",
      schedule: "1d",
      prompt,
      enabled: true,
      runCount: 1,
      createdAt: 1,
      cwd: root,
      resumeSessionId: "session-a",
      lastRunId: "run-one",
    },
    prompt,
    signal,
    ...resolveWritePolicy("full"),
  });
  const state = async () => {
    const result = await bridge.request(
      "test/state",
      {},
      {
        id: "state",
        consume: true,
        settleOnExit: true,
        failFast: true,
        timeoutMs: 1000,
        meta: { origin: "host", producer: "test" },
      },
    );
    if (result.status !== "result") throw Error(result.status);
    return result.result as any;
  };
  return {
    root,
    bridge,
    worker,
    request,
    state,
    held: () => held,
    released: () => released,
    ready: () => ready,
  };
}
async function until(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw Error("timed out");
    await Bun.sleep(5);
  }
}

test("unattended approvals use the tier once and preserve the Worker routing tuple", async () => {
  const f = fixture();
  let policyCalls = 0;
  const request = f.request("approve");
  const backend = request.approvalBackend;
  request.approvalBackend = {
    requestApproval: (input) => {
      policyCalls++;
      return backend.requestApproval(input);
    },
  };
  await f.worker.execute(request);
  const state = await f.state();
  expect(policyCalls).toBe(1);
  expect(state.approvals).toHaveLength(1);
  expect(state.approvals[0]).toMatchObject({
    sessionId: "session-a",
    requestId: "approval-1",
    connectionId: "worker-route",
    generation: 42,
    decision: { approved: true },
  });
  expect(f.held()).toBe(false);
  expect(f.released()).toBe(1);
});

test("page-owned internal callbacks are denied without calling the broad permission tier", async () => {
  const f = fixture();
  const request = f.request("internal");
  request.approvalBackend = {
    requestApproval: async () => {
      throw Error("must not approve internal callbacks");
    },
  };
  await f.worker.execute(request);
  expect((await f.state()).approvals[0].decision).toMatchObject({
    approved: false,
    failure: "unavailable",
  });
});

test("cancellation keeps exclusive Session ownership until the actual run result", async () => {
  const f = fixture();
  const signal = new AbortController();
  const executing = f.worker.execute(f.request("hold", signal.signal));
  await until(() => f.bridge.hasChild());
  expect(f.worker.ownsSession("session-a")).toBe(true);
  await expect(f.worker.execute(f.request("approve"))).rejects.toThrow(/active automation/);
  signal.abort();
  expect(f.held()).toBe(true);
  await executing;
  expect(f.held()).toBe(false);
  expect(f.released()).toBe(1);
});

test("a Web-initiated stop is cancellation, while worker exit is an unknown outcome", async () => {
  const f = fixture();
  const executing = f.worker.execute(f.request("hold"));
  const rejected = executing.then(
    () => undefined,
    (error) => error,
  );
  await until(() => f.bridge.hasChild());
  await f.bridge.request(
    "agent/cancel",
    { sessionId: "session-a" },
    {
      id: "external-cancel",
      consume: true,
      settleOnExit: true,
      failFast: true,
      timeoutMs: 1000,
      meta: { origin: "serve", producer: "test" },
    },
  );
  expect(await rejected).toBeInstanceOf(HubAutomationCancelledError);
  await expect(f.worker.execute(f.request("crash"))).rejects.toBeInstanceOf(
    HubAutomationUncertainError,
  );
  expect(f.held()).toBe(false);
});

test("admission timeout waits for actual process exit before releasing the Session", async () => {
  const f = fixture(250);
  const executing = f.worker.execute(f.request("silent"));
  const rejected = executing.then(
    () => undefined,
    (error) => error,
  );
  await until(f.ready);
  await Bun.sleep(260);
  expect(f.held()).toBe(true);
  expect(await rejected).toBeInstanceOf(HubAutomationUncertainError);
  expect(f.bridge.hasChild()).toBe(false);
  expect(f.released()).toBe(1);
});
