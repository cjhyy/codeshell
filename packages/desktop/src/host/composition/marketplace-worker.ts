import { seedDefaults } from "../../main/seed-defaults.js";
import { bootstrapCorePlugins } from "../../main/bootstrap-core-plugins.js";
import { applyGitPathFromSettings } from "../../main/git-path-settings.js";
import { parentPort } from "node:worker_threads";
import * as market from "../../main/marketplace-service.js";
import { uninstallPluginEntry, updatePluginEntry } from "../../main/plugins-service.js";
import type { MarketplaceOperations } from "../../shared/plugin-library.js";
import { claimBusinessCommit } from "./business-calls.js";
type Handlers = {
  [K in keyof MarketplaceOperations]: (
    input: MarketplaceOperations[K]["input"],
    accept: () => void,
  ) => MarketplaceOperations[K]["result"] | Promise<MarketplaceOperations[K]["result"]>;
};
const handlers: Handlers = {
  async "marketplace/bootstrap"({ resourcesDir }) {
    await seedDefaults(resourcesDir);
    await bootstrapCorePlugins();
  },
  "marketplace/list": () => market.listMarketplacesForUi(),
  "marketplace/load": ({ name }) => market.loadMarketplaceForUi(name),
  "marketplace/jobs": () => market.listPluginInstallJobsForUi(),
  "marketplace/recommended": () => market.listRecommendedMarketplacesForUi(),
  "marketplace/add": ({ source }, claim) => market.addMarketplaceFromInput(source, claim),
  "marketplace/addRecommended": ({ id }, claim) => market.addRecommendedMarketplaceForUi(id, claim),
  "marketplace/remove": ({ name }, claim) => market.removeMarketplaceForUi(name, claim),
  "marketplace/refresh": ({ name }, claim) => market.refreshMarketplaceForUi(name, claim),
  "marketplace/install": ({ pluginName, marketplaceName }, claim) =>
    market.installPluginForUi(pluginName, marketplaceName, claim),
  "marketplace/retry": ({ id }, claim) => market.retryPluginInstallJobForUi(id, claim),
  "marketplace/uninstall": ({ pluginName, marketplaceName }, claim) =>
    uninstallPluginEntry(pluginName, marketplaceName, claim),
  "marketplace/updatePlugin": ({ installKey }, claim) =>
    updatePluginEntry(installKey, undefined, claim),
};
if (!parentPort) throw Error("Marketplace requires its Host thread");
const port = parentPort;
market.onPluginInstallJobsChanged((jobs) => port.postMessage({ type: "jobs", jobs }));
let active = 0;
let drainId: number | undefined;
const tryDrain = () => {
  if (
    drainId !== undefined &&
    active === 0 &&
    !market
      .listPluginInstallJobsForUi()
      .some((j) => j.status === "queued" || j.status === "installing")
  ) {
    port.postMessage({ id: drainId });
    drainId = undefined;
  }
};
market.onPluginInstallJobsChanged(tryDrain);
port.on(
  "message",
  async <K extends keyof Handlers>({
    id,
    method,
    input,
    permit,
  }: {
    id: number;
    method: K;
    input: MarketplaceOperations[K]["input"];
    permit?: Int32Array;
  }) => {
    if ((method as string) === "drain") {
      drainId = id;
      tryDrain();
      return;
    }
    ++active;
    try {
      if (!Object.hasOwn(handlers, method)) throw Error("Unknown marketplace operation");
      if (permit && Atomics.load(permit, 0) < 0) throw Error("Document write was revoked");
      if (
        [
          "marketplace/bootstrap",
          "marketplace/add",
          "marketplace/addRecommended",
          "marketplace/refresh",
          "marketplace/install",
          "marketplace/retry",
          "marketplace/updatePlugin",
        ].includes(method)
      )
        await applyGitPathFromSettings();
      const value = await handlers[method](input, () => {
        if (!permit) throw Error("Missing marketplace write permit");
        claimBusinessCommit(permit);
      });
      port.postMessage({
        id,
        value,
        commands:
          !!permit &&
          Atomics.load(permit, 0) === 1 &&
          (method === "marketplace/uninstall" || method === "marketplace/updatePlugin"),
      });
    } catch (error) {
      port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    } finally {
      --active;
      tryDrain();
    }
  },
);
