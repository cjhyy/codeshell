// Cross-repository verifier only; products do not import sibling source paths.
// Uses the actual Node Host storage service and its disk/permission boundaries.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PanelRuntimeServices } from "../packages/server/dist/panels/runtime-services.js";
import { panelAppStoragePath } from "../packages/server/dist/panels/storage-store.js";

if (!process.argv[2])
  throw Error("Usage: node scripts/smoke-quant-project-setting.mjs /path/to/codeshell-panel-apps");
const { createProjectSetting } = await import(
  pathToFileURL(join(resolve(process.argv[2]), "apps/quant-lab/app/modules/project-setting.mjs"))
    .href
);
const root = await mkdtemp(join(tmpdir(), "codeshell-quant-storage-"));
const dataDir = join(root, "data");
const methods = ["storage.getSnapshot", "storage.compareAndSet"];
let active = true;
let readbackFailure = false;
let commitResponseLoss = false;
let writes = 0;
try {
  const projectA = join(root, "project-a"),
    projectB = join(root, "project-b");
  await Promise.all([mkdir(projectA), mkdir(projectB)]);
  const scope = (cwd) => ({
    appId: "quant-lab",
    cwd,
    projectPath: cwd,
    permissions: ["storage"],
    isAuthorized: async () => active,
  });
  const device = (cwd, service = new PanelRuntimeServices({ dataDir })) =>
    createProjectSetting({
      key: "dataSources",
      currentEpoch: () => cwd,
      getContext: () => ({ availableMethods: methods }),
      hostCall: async (method, params) => {
        if (method === "storage.getSnapshot" && readbackFailure)
          throw Error("fixture readback unavailable");
        if (method === "storage.compareAndSet") writes++;
        const result = await service.call(scope(cwd), method, params);
        if (method === "storage.compareAndSet" && commitResponseLoss) {
          commitResponseLoss = false;
          throw Error("fixture lost response after real commit");
        }
        return result;
      },
    });
  const a = device(projectA),
    b = device(projectA),
    other = device(projectB);
  await Promise.all([a.load(), b.load(), other.load()]);
  await a.save({ version: 1, industry: "eastmoney", endpoint: "", label: "" });
  await assert.rejects(b.save({ version: 1, industry: "sina" }), { code: "STORAGE_CONFLICT" });
  const beforeRetry = writes;
  await assert.rejects(b.save({ version: 1, industry: "sina" }), { code: "STORAGE_CONFLICT" });
  assert.equal(writes, beforeRetry);
  assert.equal(await other.load(), null);
  // Recreate the service and Panel adapter: no page cache is available.
  const reopened = device(projectA);
  assert.equal((await reopened.load()).industry, "eastmoney");
  commitResponseLoss = true;
  const beforeLost = writes;
  await reopened.save({ version: 1, industry: "sina", endpoint: "", label: "" });
  assert.equal(writes, beforeLost + 1);
  assert.equal((await device(projectA).load()).industry, "sina");
  const file = panelAppStoragePath(dataDir, "quant-lab", projectA);
  const stored = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(stored.dataSources, { version: 1, industry: "sina", endpoint: "", label: "" });
  assert.deepEqual(
    Object.keys(stored),
    ["dataSources"],
    "no revision wrapper or alternate browser namespace",
  );
  // Revocation and a failed readback must not authorize an unconditional write.
  active = false;
  readbackFailure = true;
  await assert.rejects(reopened.save({ version: 1, industry: "auto" }), {
    code: "STORAGE_UNCERTAIN",
  });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), stored);
  active = true;
  readbackFailure = false;
  const beforeBlocked = writes;
  await assert.rejects(reopened.save({ version: 1, industry: "auto" }), {
    code: "STORAGE_UNCERTAIN",
  });
  assert.equal(writes, beforeBlocked);
  console.log(
    "✓ Quant project settings: actual Host disk/CAS, separate project isolation, recreated service, lost-response reconciliation and revoked owner; no real browser transport or market provider claimed",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
