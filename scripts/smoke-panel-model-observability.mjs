import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { previewLocalPanelApp, installReviewedLocalPanelApp } from "@cjhyy/code-shell-core";
import { ModelTraceStore } from "@cjhyy/code-shell-core/internal";
import {
  PanelAppProcessService,
  PanelModelTraceService,
  resolvePanelExecutable,
} from "../packages/server/dist/index.panels.js";

// Run through run-isolated-node-smoke.mjs. Models and external network are unused.
if (!process.env.CODE_SHELL_TEST_HOME?.startsWith(process.env.HOME + "/"))
  throw new Error("This smoke requires an isolated Host HOME");
const repository = process.argv[2];
if (!repository) throw new Error("Pass the stable or task Panel Apps repository path");
const root = await mkdtemp(join(tmpdir(), "panel-model-observability-"));
let processes, service;
try {
  const source = join(root, "package"),
    workspace = join(root, "workspace"),
    bin = join(root, "bin");
  await mkdir(join(source, ".codeshell-panel"), { recursive: true });
  await mkdir(join(source, "app/tools"), { recursive: true });
  await mkdir(workspace);
  await mkdir(bin);
  await writeFile(
    join(source, "app/index.html"),
    "<!doctype html><title>Observability fixture</title>",
  );
  await writeFile(
    join(source, "app/model-observability.mjs"),
    await readFile(join(resolve(repository), "shared/model-observability.mjs")),
  );
  const entry = `import { observeModelCall } from '../model-observability.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
globalThis.fetch = () => { throw new Error('Fixture cannot use network'); };
if (process.argv[2] === 'worker') {
  for (let call=0;call<2;call++) await observeModelCall({provider:'fixture',model:'fixture-voice',purpose:'tts',
    input:{messages:[{role:'user',content:'PROMPT-'+process.argv[3]+'-'+call+' '+ '文稿'.repeat(14000)}],
      parameters:{authorization:'NEVER_RECORD_SECRET',request:{voice:'fixture',speed:1}}}},
    async()=>({durationSeconds:2}), {output:data=>({data})});
  console.log('ordinary-'+process.argv[3]);
} else await Promise.all(Array.from({length:8},(_,i)=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'worker',String(i)],
    {env:process.env,stdio:['ignore','pipe','pipe',3]});
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  child.once('error',reject); child.once('close',code=>code===0?resolve():reject(new Error('child failed')));
})));`;
  await writeFile(join(source, "app/tools/model.mjs"), entry);
  await writeFile(
    join(source, ".codeshell-panel/panel.json"),
    JSON.stringify({
      schemaVersion: 2,
      id: "observability-fixture",
      version: "1.0.0",
      title: { default: "Observability fixture" },
      entry: "app/index.html",
      permissions: ["process", "resources", "context.workspace"],
      nativeEntries: {
        model: {
          entry: "app/tools/model.mjs",
          sha256: createHash("sha256").update(entry).digest("hex"),
        },
      },
    }),
  );
  const input = { kind: "dir", path: source };
  const review = await previewLocalPanelApp(input);
  const installed = await installReviewedLocalPanelApp(
    input,
    review.reviewToken,
    new Date().toISOString(),
  );
  const node = await resolvePanelExecutable("node", {
    extraPathDirectories: [dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin"],
  });
  assert.ok(node);
  await symlink(node, join(bin, "node"));
  const storageDir = join(root, "traces"),
    store = new ModelTraceStore({ storageDir });
  assert.equal(store.getConfig().captureContent, true);
  assert.equal(store.getConfig().includeEphemeral, true);
  service = new PanelModelTraceService({ storageDir });
  const output = [];
  const owner = {
    guestId: 7,
    appId: installed.id,
    appTitle: installed.title.default,
    revision: installed.packageDigest,
    send(event, payload) {
      if (event === "process.output") output.push(payload.text);
    },
  };
  processes = new PanelAppProcessService({
    env: { PATH: bin },
    confirmExecution: async () => true,
    isOwnerAuthorized: () => true,
    resolvePackageEntry: async (_owner, name) => {
      assert.equal(name, "model");
      const declared = installed.nativeEntries.model;
      return { path: join(installed.installPath, declared.entry), sha256: declared.sha256 };
    },
    modelTraces: service,
    modelTraceOwner: () => ({
      appId: installed.id,
      revision: owner.revision,
      workspacePath: workspace,
      taskId: "trusted-task",
      traceId: "trusted-task",
    }),
  });
  const executable = await processes.findExecutable(owner, { name: "node" });
  const tool = await processes.resolveEntry(owner, {
    name: "model",
    executableHandle: executable.handle,
  });
  const directory = await processes.grantDirectory(owner, workspace);
  const launch = await processes.start(owner, {
    executableHandle: executable.handle,
    directoryHandle: directory.handle,
    entryHandle: tool.handle,
    args: [],
  });
  const deadline = Date.now() + 15000;
  let receipt;
  while (Date.now() < deadline) {
    receipt = await processes.get(owner, { processId: launch.processId });
    if (receipt.status === "exited") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(receipt.status, "exited");
  assert.equal(receipt.code, 0);
  while (store.list().items.some((row) => row.status === "running") && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const page = store.list({ limit: 100 });
  assert.equal(page.total, 16);
  const records = page.items.map((row) => store.get(row.id));
  assert.ok(
    records.every(
      (row) =>
        row.status === "completed" &&
        row.source === "panel:observability-fixture" &&
        row.workspacePath === workspace,
    ),
  );
  for (let worker = 0; worker < 8; worker++)
    for (let call = 0; call < 2; call++)
      assert.ok(
        records.some((row) => JSON.stringify(row.input).includes("PROMPT-" + worker + "-" + call)),
      );
  assert.ok(
    records.every(
      (row) =>
        row.output.data.durationSeconds === 2 && row.attempts[0].coverage === "logical-input",
    ),
  );
  assert.ok(!JSON.stringify(records).includes("NEVER_RECORD_SECRET"));
  assert.equal(
    output
      .join("")
      .split("\n")
      .filter((line) => line.startsWith("ordinary-")).length,
    8,
  );
  assert.ok(!output.join("").includes("model_trace"));
  console.log(
    "PASS: reviewed installed Panel + real shared SDK + 8 concurrent native children → 16 scoped model histories, default Prompt capture, redaction and untouched stdout",
  );
} finally {
  processes?.close();
  service?.closeAll();
  await rm(root, { recursive: true, force: true });
}
