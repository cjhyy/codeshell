import { PetNoticeLedgerError, type PetNoticeLedger } from "../pet/pet-notice-ledger.js";
import type { CallShellBusiness } from "../../shared/shell-business-contracts.js";
import type {
  NoticeLedgerMethod,
  NoticeLedgerCall,
  MimiNoticeLedger,
} from "../../shared/mimi-notice-ledger.js";
import { currentMimiRuleDocument } from "./mimi-rules-client.js";

export function nativeMimiNoticeLedger(call: CallShellBusiness): MimiNoticeLedger {
  const method =
    <K extends NoticeLedgerMethod>(method: K) =>
    async (
      ...args: Parameters<PetNoticeLedger[K]>
    ): Promise<Awaited<ReturnType<PetNoticeLedger[K]>>> => {
      const reply = await call(
        "mimi/noticeLedger",
        { method, args } as NoticeLedgerCall,
        currentMimiRuleDocument(),
      );
      if (!reply.ok) throw new PetNoticeLedgerError(reply.code);
      return reply.value as Awaited<ReturnType<PetNoticeLedger[K]>>;
    };
  return {
    load: method("load"),
    flush: method("flush"),
    get: method("get"),
    byDedupeKey: method("byDedupeKey"),
    byPromptCode: method("byPromptCode"),
    byActionCode: method("byActionCode"),
    changedSince: method("changedSince"),
    readRows: method("readRows"),
    decisionRows: method("decisionRows"),
    actionRecords: method("actionRecords"),
    updateActions: method("updateActions"),
    prompts: async (only) => {
      const rows = await method("prompts")();
      return only ? rows.filter((row) => only(row.prompt!)) : rows;
    },
    forRequest: method("forRequest"),
    adoptPrompt: method("adoptPrompt"),
    updatePrompt: method("updatePrompt"),
    hasSeen: method("hasSeen"),
    routingState: method("routingState"),
    waiting: method("waiting"),
    queued: method("queued"),
    enqueued: method("enqueued"),
    held: method("held"),
    countsThisHour: method("countsThisHour"),
    record: method("record"),
    claim: method("claim"),
    settle: method("settle"),
    expireQueued: method("expireQueued"),
    recoverOnStartup: method("recoverOnStartup"),
  };
}
