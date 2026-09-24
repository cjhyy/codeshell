// Verification-only cross-repository import. Uses real persistent scheduling;
// the transport/authority adapter is a fixture, not the Electron or Web bridge.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CronScheduler } from "../packages/core/dist/automation/scheduler.js";
import { CronStore } from "../packages/core/dist/automation/store.js";
import { panelAutomationCreationKey } from "../packages/server/dist/panels/automations.js";

if (!process.argv[2])
  throw Error(
    "Usage: node scripts/smoke-quant-unique-automation.mjs /path/to/codeshell-panel-apps",
  );
const app = join(resolve(process.argv[2]), "apps/quant-lab/app");
const { createAlertsController } = await import(pathToFileURL(join(app, "modules/alerts-ui.mjs")));
const { createNewsController } = await import(pathToFileURL(join(app, "modules/news-ui.mjs")));
const { createMarketPulseAutomationController } = await import(
  pathToFileURL(join(app, "modules/market-insights-ui.mjs"))
);
const { parseNewsSubscriptions } = await import(pathToFileURL(join(app, "news-feed.mjs")));
const root = await mkdtemp(join(tmpdir(), "codeshell-quant-unique-"));
const schedulers = [];
const node = () => ({
  dataset: {},
  value: "",
  checked: false,
  addEventListener() {},
  setAttribute() {},
});
const cases = [
  { kind: "alerts", key: "market-alert.us", market: "us" },
  { kind: "news", key: "news-sync.cn", market: "cn" },
  { kind: "news", key: "news-sync.us", market: "us" },
  { kind: "pulse", key: "market-pulse.daily" },
];
try {
  for (const spec of cases) {
    let creations = 0,
      release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const storePath = join(root, `${spec.key}.json`);
    const store = new CronStore(storePath);
    function page({ waitForPeer = false, loseResponse = false, session = "session-a" } = {}) {
      // Independent stores share the same real lock and persistent file.
      const pageStore = new CronStore(storePath);
      const scheduler = new CronScheduler(pageStore);
      scheduler.setExecutionEnabled(false);
      schedulers.push(scheduler);
      const hostCall = async (method, params) => {
        if (method === "automations.list")
          return pageStore.load().filter((job) => job.resumeSessionId === session);
        assert.equal(method, "automations.createUnique");
        assert.equal(params.key, spec.key);
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
          creationKey: panelAutomationCreationKey("quant-lab", root, session, params.key),
        });
        if (loseResponse) {
          loseResponse = false;
          throw Error("fixture lost response after persistent commit");
        }
        return task;
      };
      const common = {
        hostCall,
        getContext: () => ({ availableMethods: ["automations.createUnique"] }),
      };
      if (spec.kind === "pulse") {
        const controller = createMarketPulseAutomationController({
          ...common,
          elements: { root: node(), status: node(), schedule: node(), action: node() },
        });
        return {
          toggle: () => controller.toggle(),
          load: () => controller.load(),
          task: () => controller.state.task,
          error: () => controller.state.error,
        };
      }
      if (spec.kind === "news") {
        const nodes = new Map();
        const controller = createNewsController({
          ...common,
          currentEpoch: () => 1,
          subscriptionSymbols: () => [],
          root: {
            querySelector: (id) => {
              if (!nodes.has(id)) nodes.set(id, node());
              return nodes.get(id);
            },
            querySelectorAll: () => [],
          },
        });
        controller.state.subscriptions = parseNewsSubscriptions(
          JSON.stringify({
            format: "codeshell.news-subscriptions",
            version: 1,
            enabledSources: spec.market === "us" ? ["sec-edgar"] : ["eastmoney-stock"],
            symbols: [
              {
                symbol: spec.market === "us" ? "AAPL" : "SH600519",
                market: spec.market,
                origins: ["watch"],
              },
            ],
            secContact: spec.market === "us" ? "Test app test@example.com" : null,
            updatedAt: "2026-09-24T00:00:00.000Z",
          }),
        );
        return {
          toggle: () => controller.toggleMarket(spec.market),
          load: () => {
            controller.state.taskRetryIntent[spec.market] = "read";
            return controller.toggleMarket(spec.market);
          },
          task: () => controller.state.tasks[0] ?? null,
          error: () => controller.state.taskErrors[spec.market],
        };
      }
      const row = () => ({ root: node(), status: node(), button: node(), time: node() });
      const controller = createAlertsController({
        ...common,
        elements: { master: node(), summary: node(), markets: { cn: row(), us: row() } },
        watchlist: () => [
          { id: "rule", symbol: "AAPL", rule: { type: "price-above", threshold: 200 } },
        ],
      });
      return {
        toggle: () => controller.toggleMarket("us"),
        load: () => controller.load(),
        task: () => controller.state.tasks.us,
        error: () => controller.state.errors.us,
      };
    }
    const a = page({ waitForPeer: true }),
      b = page({ waitForPeer: true, loseResponse: true });
    await Promise.all([a.toggle(), b.toggle()]);
    assert.equal(creations, 2);
    assert.equal(store.load().length, 1);
    assert.match(b.error(), /未确认/);
    const editor = new CronScheduler(new CronStore(storePath));
    editor.setExecutionEnabled(false);
    schedulers.push(editor);
    const retained = store.load()[0];
    assert.ok(
      editor.update(retained.id, { prompt: "Saved by another device before reconciliation" }),
    );
    await b.toggle();
    assert.equal(creations, 2, "manual retry only reads the persisted job");
    assert.equal(b.error(), null);
    assert.equal(b.task().prompt, "Saved by another device before reconciliation");
    assert.equal(store.load()[0].prompt, b.task().prompt);
    assert.equal(a.task().id, b.task().id);
    const reopened = page();
    await reopened.load();
    assert.equal(reopened.task().id, a.task().id);
    const other = page({ session: "session-b" });
    await other.load();
    assert.equal(other.task(), null);
    await other.toggle();
    assert.equal(other.error(), null);
    assert.equal(
      store.load().length,
      2,
      "different task bindings have separate retained identities",
    );
    console.log(
      `✓ ${spec.key}: actual controller + independent persistent stores, concurrent create, lost response/read preserves peer edit, reopened scheduler and separate task binding`,
    );
  }
  console.log("No Agent execution, real notifications or Web transport claimed");
} finally {
  for (const scheduler of schedulers) scheduler.stopAll();
  await rm(root, { recursive: true, force: true });
}
