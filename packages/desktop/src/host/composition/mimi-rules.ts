import { AsyncLocalStorage } from "node:async_hooks";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { PetRuleStore, PetRuleStoreError } from "../../main/pet/pet-rule-store.js";
import { mimiRuleMethods, type MimiRuleCall, type MimiRuleReply } from "../../shared/mimi-rules.js";
import { claimBusinessCommit } from "./business-calls.js";

export class StoredMimiRules {
  private readonly permit = new AsyncLocalStorage<Int32Array>();
  private readonly store: PetRuleStore;
  private revision = 0;
  constructor(petDir: string) {
    this.store = new PetRuleStore({
      path: join(petDir, "rules.json"),
      replaceFile: async (from, to) => {
        const permit = this.permit.getStore();
        if (!permit) throw Error("Missing Mimi rule authority");
        claimBusinessCommit(permit);
        renameSync(from, to);
      },
    });
    this.store.onChange(() => {
      this.revision++;
    });
  }
  async run({ call, permit }: { call: MimiRuleCall; permit: Int32Array }): Promise<MimiRuleReply> {
    if (
      !call ||
      !mimiRuleMethods.includes(call.method) ||
      !Array.isArray(call.args) ||
      !(permit instanceof Int32Array)
    )
      throw Error("Invalid Mimi rule command");
    return this.permit.run(permit, async () => {
      await this.store.load();
      await this.store.flush();
      if (Atomics.load(permit, 0) < 0) throw Error("Mimi rule authority expired");
      const revision = this.revision;
      try {
        const value = await Reflect.apply(this.store[call.method], this.store, call.args);
        return { ok: true, value, changed: this.revision !== revision };
      } catch (error) {
        if (error instanceof PetRuleStoreError) return { ok: false, code: error.code };
        throw error;
      }
    });
  }
}
