import { invalidateSkillCache } from "@cjhyy/code-shell-core";
import { Worker } from "node:worker_threads";
import type { PluginPackageOperations } from "../../shared/plugin-library.js";
import type { ProfilePackageOperations } from "../../shared/profile-library.js";
import type { SkillOperations } from "../../shared/skill-operations.js";
import type { BusinessGrant, BusinessMethods } from "./business-calls.js";

/** Network downloads and bundle hashing run independently of the Host port and SQLite writer. */
type ExtensionOperations = SkillOperations & ProfilePackageOperations & PluginPackageOperations;
export function hostedSkills(url: URL, pluginChanged: (requestId: string) => void) {
  const pending = new Set<Promise<unknown>>();
  let closing = false;
  function route<K extends keyof ExtensionOperations>(method: K) {
    return async (input: ExtensionOperations[K]["input"], grant: BusinessGrant) => {
      while (!closing && pending.size >= 4) {
        await Promise.race(pending).catch(() => undefined);
        grant.assertCurrent();
      }
      if (closing) throw new Error("Extension service is closed");
      grant.assertCurrent();
      const worker = new Worker(url, { workerData: { method, input, permit: grant.permit } });
      const result = new Promise<ExtensionOperations[K]["result"]>((resolve, reject) => {
        worker.once("message", (reply) => {
          if (typeof reply.error === "string") reject(new Error(reply.error));
          else {
            if (Atomics.load(grant.permit, 0) === 1) {
              invalidateSkillCache();
              if (
                method === "plugins/uninstallLocal" ||
                (method === "plugins/installLocal" && reply.value?.ok)
              )
                pluginChanged(grant.requestId);
            }
            resolve(reply.value);
          }
        });
        worker.once("error", reject);
        worker.once("exit", (code) => reject(new Error(`Extension worker exited (${code})`)));
      });
      const settled = result.finally(async () => {
        try {
          await worker.terminate();
        } finally {
          pending.delete(settled);
        }
      });
      pending.add(settled);
      return settled;
    };
  }
  return {
    methods: {
      "plugins/previewLocal": route("plugins/previewLocal"),
      "plugins/installLocal": route("plugins/installLocal"),
      "plugins/uninstallLocal": route("plugins/uninstallLocal"),
      "plugins/checkUpdate": route("plugins/checkUpdate"),
      "profiles/addRepo": route("profiles/addRepo"),
      "profiles/previewRequirements": route("profiles/previewRequirements"),
      "profiles/installRequirements": route("profiles/installRequirements"),
      "skills/inspectGithub": route("skills/inspectGithub"),
      "skills/installGithub": route("skills/installGithub"),
      "skills/installLocal": route("skills/installLocal"),
      "skills/uninstall": route("skills/uninstall"),
      "skills/update": route("skills/update"),
    } satisfies Pick<BusinessMethods, keyof ExtensionOperations>,
    async close() {
      closing = true;
      await Promise.allSettled(pending);
    },
  };
}
