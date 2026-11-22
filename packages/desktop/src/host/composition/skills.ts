import { invalidateSkillCache } from "@cjhyy/code-shell-core";
import { Worker } from "node:worker_threads";
import type { SkillOperations } from "../../shared/skill-operations.js";
import type { BusinessGrant, BusinessMethods } from "./business-calls.js";

/** Network downloads and bundle hashing run independently of the Host port and SQLite writer. */
export function hostedSkills(url: URL) {
  const pending = new Set<Promise<unknown>>();
  let closing = false;
  function route<K extends keyof SkillOperations>(method: K) {
    return async (input: SkillOperations[K]["input"], grant: BusinessGrant) => {
      while (!closing && pending.size >= 4) {
        await Promise.race(pending).catch(() => undefined);
        grant.assertCurrent();
      }
      if (closing) throw new Error("Skill service is closed");
      grant.assertCurrent();
      const worker = new Worker(url, { workerData: { method, input, permit: grant.permit } });
      const result = new Promise<SkillOperations[K]["result"]>((resolve, reject) => {
        worker.once("message", (reply) => {
          if (typeof reply.error === "string") reject(new Error(reply.error));
          else {
            if (Atomics.load(grant.permit, 0) === 1) invalidateSkillCache();
            resolve(reply.value);
          }
        });
        worker.once("error", reject);
        worker.once("exit", (code) => reject(new Error(`Skill worker exited (${code})`)));
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
      "skills/inspectGithub": route("skills/inspectGithub"),
      "skills/installGithub": route("skills/installGithub"),
      "skills/installLocal": route("skills/installLocal"),
      "skills/uninstall": route("skills/uninstall"),
      "skills/update": route("skills/update"),
    } satisfies Pick<BusinessMethods, keyof SkillOperations>,
    async close() {
      closing = true;
      await Promise.allSettled(pending);
    },
  };
}
