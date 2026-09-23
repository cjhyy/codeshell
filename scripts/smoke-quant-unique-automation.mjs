// Verification-only cross-repository import. Uses real persistent scheduling;
// the transport/authority adapter is a fixture, not the Electron or Web bridge.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CronScheduler } from "../packages/core/dist/automation/scheduler.js";
import { CronStore } from "../packages/core/dist/automation/store.js";

if (!process.argv[2])
  throw Error(
    "Usage: node scripts/smoke-quant-unique-automation.mjs /path/to/codeshell-panel-apps",
  );
const { createAlertsController } = await import(
  pathToFileURL(join(resolve(process.argv[2]), "apps/quant-lab/app/modules/alerts-ui.mjs")).href
);
const root = await mkdtemp(join(tmpdir(), "codeshell-quant-unique-"));
const schedulers = [];
let creations = 0,
  release;
const gate = new Promise((resolve) => {
  release = resolve;
});
const store = new CronStore(join(root, "cron.json"));
function page({ waitForPeer = false, loseResponse = false, session = "session-a" } = {}) {
  const scheduler = new CronScheduler(store);
  scheduler.setExecutionEnabled(false);
  schedulers.push(scheduler);
  const node = () => ({ dataset: {}, addEventListener() {} });
  const row = () => ({ root: node(), status: node(), button: node(), time: node() });
  return createAlertsController({
    elements: { master: node(), summary: node(), markets: { cn: row(), us: row() } },
    getContext: () => ({ availableMethods: ["automations.createUnique"] }),
    watchlist: () => [
      { id: "rule", symbol: "AAPL", rule: { type: "price-above", threshold: 200 } },
    ],
    hostCall: async (method, params) => {
      if (method === "automations.list")
        return store.load().filter((job) => job.resumeSessionId === session);
      assert.equal(method, "automations.createUnique");
      creations++;
      if (waitForPeer) {
        if (creations === 2) release();
        await gate;
      }
      const task = scheduler.create(params.name, params.schedule, params.prompt, {
        timezone: params.timezone,
        cwd: root,
        resumeSessionId: session,
        permissionLevel: "full",
        creationKey: `fixture:${session}:${params.key}`,
      });
      if (loseResponse) {
        loseResponse = false;
        throw Error("fixture lost response after persistent commit");
      }
      return task;
    },
  });
}
try {
  const a = page({ waitForPeer: true }),
    b = page({ waitForPeer: true, loseResponse: true });
  await Promise.all([a.toggleMarket("us"), b.toggleMarket("us")]);
  assert.equal(creations, 2);
  assert.equal(store.load().length, 1);
  assert.equal(a.state.tasks.us.id, b.state.tasks.us.id);
  assert.match(b.state.errors.us, /未确认/);
  await b.toggleMarket("us");
  assert.equal(
    creations,
    2,
    "manual retry reads the committed task instead of resending or deleting",
  );
  assert.equal(b.state.errors.us, null);
  const reopened = page();
  await reopened.load();
  assert.equal(reopened.state.tasks.us.id, a.state.tasks.us.id);
  const other = page({ session: "session-b" });
  await other.load();
  assert.equal(other.state.tasks.us, null);
  await other.toggleMarket("us");
  assert.equal(store.load().length, 2, "different task bindings have separate retained identities");
  console.log(
    "✓ Actual Quant controller + persistent CronStore: concurrent retained identity, lost response/read reconciliation, recreated scheduler and separate task bindings; no Agent execution or Web transport claimed",
  );
} finally {
  for (const scheduler of schedulers) scheduler.stopAll();
  await rm(root, { recursive: true, force: true });
}
