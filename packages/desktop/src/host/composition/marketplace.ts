import { InvalidParams } from "../../main/desktop-host/server.js";
import { Worker } from "node:worker_threads";
import { invalidateSkillCache } from "@cjhyy/code-shell-core";
import type { MarketplaceOperations } from "../../shared/plugin-library.js";
import type { PluginInstallJobDTO } from "../../main/marketplace-service.js";
import {
  businessArguments,
  businessRead,
  noBusinessArguments,
  textArgument,
} from "../../main/desktop-host/business-read.js";
import type { BusinessGrant, BusinessMethods } from "./business-calls.js";

export function hostedMarketplace(
  url: URL,
  jobsChanged: (jobs: PluginInstallJobDTO[]) => void,
  commandsChanged: (id: string) => void,
) {
  let worker: Worker | undefined,
    closing = false,
    sequence = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; grant?: BusinessGrant }
  >();
  function active() {
    if (worker) return worker;
    const thread = new Worker(url);
    worker = thread;
    const failed = (error: Error) => {
      if (worker !== thread) return;
      worker = undefined;
      for (const call of pending.values()) call.reject(error);
      pending.clear();
      jobsChanged([]);
    };
    thread.on("error", failed);
    thread.on("exit", (code) => failed(new Error(`Marketplace worker exited (${code})`)));
    thread.on("message", (reply) => {
      if (worker !== thread) return;
      if (reply.type === "jobs") {
        if (reply.jobs.some((job: PluginInstallJobDTO) => job.status === "installed"))
          invalidateSkillCache();
        jobsChanged(reply.jobs);
        return;
      }
      const request = pending.get(reply.id);
      if (!request) return;
      pending.delete(reply.id);
      if (reply.commands && request.grant) {
        invalidateSkillCache();
        commandsChanged(request.grant.requestId);
      }
      if (reply.error) request.reject(new Error(reply.error));
      else request.resolve(reply.value);
    });
    return thread;
  }
  function route<K extends keyof MarketplaceOperations>(method: K) {
    return (
      input: MarketplaceOperations[K]["input"],
      grant?: BusinessGrant,
    ): Promise<MarketplaceOperations[K]["result"]> => {
      if (closing || pending.size >= 128)
        return Promise.reject(new Error("Marketplace is unavailable or busy"));
      grant?.assertCurrent();
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const thread = active();
        pending.set(id, {
          resolve: (value) => resolve(value as MarketplaceOperations[K]["result"]),
          reject,
          grant,
        });
        try {
          thread.postMessage({ id, method, input, permit: grant?.permit });
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    };
  }
  const operations = {
    "plugins/approveHooks": route("plugins/approveHooks"),
    "plugins/revokeHooks": route("plugins/revokeHooks"),
    "plugins/approveMcp": route("plugins/approveMcp"),
    "plugins/revokeMcp": route("plugins/revokeMcp"),
    "plugins/hooks": route("plugins/hooks"),
    "mcp/pluginTrust": route("mcp/pluginTrust"),

    "marketplace/bootstrap": route("marketplace/bootstrap"),
    "marketplace/list": route("marketplace/list"),
    "marketplace/load": route("marketplace/load"),
    "marketplace/jobs": route("marketplace/jobs"),
    "marketplace/recommended": route("marketplace/recommended"),
    "marketplace/add": route("marketplace/add"),
    "marketplace/addRecommended": route("marketplace/addRecommended"),
    "marketplace/remove": route("marketplace/remove"),
    "marketplace/refresh": route("marketplace/refresh"),
    "marketplace/install": route("marketplace/install"),
    "marketplace/retry": route("marketplace/retry"),
    "marketplace/uninstall": route("marketplace/uninstall"),
    "marketplace/updatePlugin": route("marketplace/updatePlugin"),
  } satisfies Pick<BusinessMethods, keyof MarketplaceOperations>;
  return {
    operations,
    reads: [
      businessRead(
        "plugins/hooks",
        (input) => {
          const { disabledPlugins } = businessArguments(input, ["disabledPlugins"]);
          if (
            disabledPlugins !== undefined &&
            (!Array.isArray(disabledPlugins) || disabledPlugins.some((x) => typeof x !== "string"))
          )
            throw new InvalidParams();
          return { disabledPlugins: disabledPlugins as string[] | undefined };
        },
        (input) => operations["plugins/hooks"](input),
      ),
      businessRead("mcp/pluginTrust", noBusinessArguments, (input) =>
        operations["mcp/pluginTrust"](input),
      ),
      businessRead("marketplace/recommended", noBusinessArguments, (input) =>
        operations["marketplace/recommended"](input),
      ),
      businessRead("marketplace/list", noBusinessArguments, (input) =>
        operations["marketplace/list"](input),
      ),
      businessRead("marketplace/jobs", noBusinessArguments, (input) =>
        operations["marketplace/jobs"](input),
      ),
      businessRead(
        "marketplace/load",
        (input) => ({ name: textArgument(businessArguments(input, ["name"]).name) }),
        (input) => operations["marketplace/load"](input),
      ),
    ],
    async close() {
      closing = true;
      const thread = worker;
      if (!thread) return;
      const id = ++sequence;
      try {
        await new Promise<void>((resolve, reject) => {
          pending.set(id, { resolve: () => resolve(), reject });
          thread.postMessage({ id, method: "drain" });
        });
      } finally {
        await thread.terminate();
      }
    },
  };
}
