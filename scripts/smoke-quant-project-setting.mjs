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
const panelModule = (name) =>
  pathToFileURL(join(resolve(process.argv[2]), "apps/quant-lab/app/modules", name)).href;
const { readSelectionWatchDocument, selectionWatchDocument } = await import(
  panelModule("selection-watch-document.mjs")
);
const { parseSelectionWatchStorage: normalizeWatch } = await import(
  panelModule("a-share-selection-ui.mjs")
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
  const device = (cwd, key = "dataSources", service = new PanelRuntimeServices({ dataDir })) =>
    createProjectSetting({
      key,
      label: key === "watchlist" ? "关注记录" : "数据源配置",
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
  const watchA = device(projectA, "watchlist"),
    watchB = device(projectA, "watchlist");
  await watchA.load();
  await watchA.save({ items: [{ symbol: "AAPL" }], watchlistMigrationVersion: 1 });
  await watchB.load();
  await watchB.assertCurrent();
  await watchA.save({
    items: [{ symbol: "AAPL" }, { symbol: "MSFT" }],
    watchlistMigrationVersion: 1,
  });
  const beforeVerify = writes;
  await assert.rejects(watchB.assertCurrent(), /其他页面或设备已修改关注记录/);
  await assert.rejects(watchB.save({ items: [] }), { code: "STORAGE_CONFLICT" });
  assert.equal(
    writes,
    beforeVerify,
    "read verification must not adopt the competing version or permit stale writes",
  );
  assert.deepEqual(
    (await device(projectA, "watchlist").load()).items.map((item) => item.symbol),
    ["AAPL", "MSFT"],
  );
  assert.equal(await device(projectB, "watchlist").load(), null);
  // Real disk persistence for long-term stocks/sectors, with two independent Hosts.
  const key = "aShareSelectionWatch";
  const longA = device(projectA, key),
    longB = device(projectA, key);
  await longA.load();
  const initial = {
    version: 2,
    custom: { retained: true },
    stocks: [{ symbol: "600519", name: "original", note: "retained" }],
    sectors: [],
  };
  await longA.save(initial);
  const beforeA = await longA.load(),
    beforeB = await longB.load();
  const remote = selectionWatchDocument(
    beforeA,
    normalizeWatch({
      ...readSelectionWatchDocument(beforeA, normalizeWatch),
      sectors: [{ id: "new_energy", name: "energy" }],
    }),
    normalizeWatch,
  );
  await longA.save(remote);
  const draft = selectionWatchDocument(
    beforeB,
    normalizeWatch({
      ...readSelectionWatchDocument(beforeB, normalizeWatch),
      stocks: [{ symbol: "SH600519", name: "my draft", priority: "focus" }],
    }),
    normalizeWatch,
  );
  await assert.rejects(longB.save(draft), { code: "STORAGE_CONFLICT" });
  assert.deepEqual(await device(projectA, key).load(), remote);
  assert.equal(draft.stocks[0].note, "retained");
  assert.equal(draft.stocks[0].priority, "focus");
  const latest = await longB.load();
  const merged = selectionWatchDocument(
    latest,
    normalizeWatch({
      ...readSelectionWatchDocument(latest, normalizeWatch),
      stocks: [{ symbol: "SH600519", name: "confirmed", priority: "focus" }],
    }),
    normalizeWatch,
  );
  commitResponseLoss = true;
  const count = writes;
  await longB.save(merged);
  assert.equal(writes, count + 1);
  assert.deepEqual(await device(projectA, key).load(), merged);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8"))[key], merged);
  assert.deepEqual(merged.custom, initial.custom);
  assert.equal(merged.stocks[0].note, "retained");
  assert.equal(merged.sectors[0].id, "new_energy");
  assert.equal(await device(projectB, key).load(), null);
  console.log(
    "✓ Quant project settings: actual Host disk/CAS, separate project isolation, recreated service, lost-response reconciliation and revoked owner and pre-operation watchlist revision checks, long-term watch conflict/reload and extension preservation; no real browser transport or market provider claimed",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
