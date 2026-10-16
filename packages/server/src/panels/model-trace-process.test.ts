import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { ModelTraceStore } from "@cjhyy/code-shell-core/internal";
import {
  PanelAppProcessService,
  resolvePanelExecutable,
  type PanelProcessOwner,
} from "./process-service.js";
import { PanelModelTraceService } from "./model-traces.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(source: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "panel-trace-process-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"),
    bin = join(root, "bin");
  await mkdir(workspace);
  await mkdir(bin);
  const entryPath = join(root, "reviewed.mjs");
  await writeFile(entryPath, source);
  const node = await resolvePanelExecutable("node", {
    extraPathDirectories: [dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin"],
  });
  if (!node) throw new Error("fixture requires Node");
  await symlink(node, join(bin, "node"));
  const storageDir = join(root, ".model-traces"),
    store = new ModelTraceStore({ storageDir });
  store.setConfig({ enabled: true, captureContent: true });
  const modelTraces = new PanelModelTraceService({ storageDir });
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const owner: PanelProcessOwner = {
    guestId: 42,
    appId: "fixture",
    appTitle: "Fixture",
    revision: "installed-revision",
    send: (event, payload) => {
      events.push({ event, payload });
    },
  };
  let authorized = true;
  const processes = new PanelAppProcessService({
    env: { PATH: bin, CODESHELL_MODEL_TRACE_FD: "3", OPENAI_API_KEY: "operator-secret" },
    confirmExecution: async () => true,
    isOwnerAuthorized: () => authorized,
    resolvePackageEntry: async () => ({
      path: entryPath,
      sha256: createHash("sha256").update(source).digest("hex"),
    }),
    modelTraces,
    modelTraceOwner: () => ({
      appId: owner.appId,
      revision: owner.revision,
      workspacePath: workspace,
      taskId: "host-task",
      traceId: "host-task",
    }),
  });
  cleanup.push(async () => {
    processes.close();
    modelTraces.closeAll();
  });
  const executable = await processes.findExecutable(owner, { name: "node" });
  const entry = await processes.resolveEntry(owner, {
    name: "fixture-entry",
    executableHandle: executable.handle,
  });
  const directory = await processes.grantDirectory(owner, workspace);
  const params = {
    executableHandle: executable.handle,
    directoryHandle: directory.handle,
    entryHandle: entry.handle,
    args: [],
  };
  return {
    processes,
    owner,
    store,
    events,
    params,
    revoke: () => {
      authorized = false;
      processes.revokeGuest(owner.guestId);
    },
  };
}
const startMessage = {
  version: 1,
  type: "model_trace",
  phase: "start",
  callId: "call-1",
  provider: "fake-provider",
  model: "fake-model",
  input: {
    systemPrompt: "exact system",
    messages: [{ role: "user", content: "exact native prompt" }],
    tools: [],
    parameters: { Authorization: "Bearer sealed-secret" },
  },
};
function program(tail: string) {
  return `import {writeSync} from 'node:fs';if(process.env.CODESHELL_MODEL_TRACE_FD!=='3')throw Error('missing reviewed channel');if(process.env.OPENAI_API_KEY)throw Error('operator credential leaked');writeSync(3,${JSON.stringify(JSON.stringify(startMessage) + "\n")});${tail}`;
}
test("installed reviewed native entry records model calls through FD3 while stdout stays unchanged", async () => {
  const finish = {
    version: 1,
    type: "model_trace",
    phase: "finish",
    callId: "call-1",
    status: "completed",
    output: { text: "exact native response" },
    usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
  };
  const f = await fixture(
    program(
      `writeSync(3,${JSON.stringify(JSON.stringify(finish) + "\n")});console.log('plain stdout remains plain');`,
    ),
  );
  const result = await f.processes.start(f.owner, f.params);
  expect((await f.processes.waitForExit(f.owner, result)).code).toBe(0);
  expect(
    f.events
      .filter((event) => event.event === "process.output")
      .map((event) => event.payload.text)
      .join(""),
  ).toBe("plain stdout remains plain\n");
  const records = f.store.list().items;
  expect(records).toHaveLength(1);
  const record = f.store.get(records[0]!.id)!;
  expect(record).toMatchObject({
    source: "panel:fixture",
    traceId: "host-task",
    status: "completed",
    output: { text: "exact native response" },
  });
  expect(record.input?.messages).toEqual(startMessage.input.messages);
  expect(record.attempts[0]?.coverage).toBe("logical-input");
  expect(JSON.stringify(record)).not.toContain("sealed-secret");
});
test("native process failure and revocation close unfinished model calls", async () => {
  const failed = await fixture(program("process.exitCode=1;"));
  const result = await failed.processes.start(failed.owner, failed.params);
  await failed.processes.waitForExit(failed.owner, result);
  expect(failed.store.list().items[0]?.status).toBe("failed");
  const cancelled = await fixture(program("setTimeout(()=>{},10000);"));
  const running = await cancelled.processes.start(cancelled.owner, cancelled.params);
  const exit = cancelled.processes.waitForExit(cancelled.owner, running);
  const until = Date.now() + 5000;
  while (!cancelled.store.list().items.length) {
    if (Date.now() > until) throw new Error("observation not received");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  cancelled.revoke();
  await exit;
  expect(cancelled.store.list().items[0]?.status).toBe("cancelled");
});
test("ordinary process execution gets no descriptor or inherited trace authority", async () => {
  const f = await fixture("");
  const params = {
    ...f.params,
    entryHandle: undefined,
    args: [
      "-e",
      "if(process.env.CODESHELL_MODEL_TRACE_FD)throw Error('forged channel');console.log('ordinary');",
    ],
  };
  const result = await f.processes.start(f.owner, params);
  expect((await f.processes.waitForExit(f.owner, result)).code).toBe(0);
  expect(f.store.list().items).toHaveLength(0);
});
