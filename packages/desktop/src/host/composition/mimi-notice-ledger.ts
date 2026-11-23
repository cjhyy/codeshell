import { AsyncLocalStorage } from "node:async_hooks";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { PetNoticeLedger, PetNoticeLedgerError } from "../../main/pet/pet-notice-ledger.js";
import {
  noticeLedgerMethods,
  type NoticeLedgerCall,
  type NoticeLedgerReply,
} from "../../shared/mimi-notice-ledger.js";
import { claimBusinessCommit } from "./business-calls.js";

export class StoredMimiNoticeLedger {
  private readonly permits = new AsyncLocalStorage<Int32Array>();
  private readonly ledger: PetNoticeLedger;
  constructor(petDir: string) {
    this.ledger = new PetNoticeLedger({
      path: join(petDir, "notices.json"),
      replaceFile: async (from, to) => {
        const permit = this.permits.getStore();
        if (!permit) throw Error("Missing Mimi notice transaction");
        if (Atomics.load(permit, 0) !== 1) claimBusinessCommit(permit);
        renameSync(from, to);
      },
    });
  }
  async run({
    call,
    permit,
  }: {
    call: NoticeLedgerCall;
    permit: Int32Array;
  }): Promise<NoticeLedgerReply> {
    if (
      !call ||
      !noticeLedgerMethods.includes(call.method) ||
      !Array.isArray(call.args) ||
      !(permit instanceof Int32Array)
    )
      throw Error("Invalid Mimi notice operation");
    return this.permits.run(permit, async () => {
      await this.ledger.load();
      await this.ledger.flush();
      if (Atomics.load(permit, 0) < 0) throw Error("Mimi notice authority expired");
      try {
        return {
          ok: true,
          value: await Reflect.apply(this.ledger[call.method], this.ledger, call.args),
        };
      } catch (error) {
        if (error instanceof PetNoticeLedgerError) return { ok: false, code: error.code };
        throw error;
      }
    });
  }
}
