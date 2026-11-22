import type { PetNoticeLedger, PetNoticeLedgerErrorCode } from "../main/pet/pet-notice-ledger.js";

export const noticeLedgerMethods = [
  "load",
  "flush",
  "get",
  "byDedupeKey",
  "byPromptCode",
  "byActionCode",
  "changedSince",
  "readRows",
  "decisionRows",
  "actionRecords",
  "updateActions",
  "prompts",
  "forRequest",
  "adoptPrompt",
  "updatePrompt",
  "hasSeen",
  "routingState",
  "waiting",
  "queued",
  "enqueued",
  "held",
  "countsThisHour",
  "record",
  "claim",
  "settle",
  "expireQueued",
  "recoverOnStartup",
] as const satisfies readonly (keyof PetNoticeLedger)[];
export type NoticeLedgerMethod = (typeof noticeLedgerMethods)[number];
export type NoticeLedgerCall = {
  [K in NoticeLedgerMethod]: {
    method: K;
    args: K extends "prompts" ? [] : Parameters<PetNoticeLedger[K]>;
  };
}[NoticeLedgerMethod];
export type NoticeLedgerReply =
  | { ok: true; value: unknown }
  | { ok: false; code: PetNoticeLedgerErrorCode };
export type MimiNoticeLedger = {
  [K in NoticeLedgerMethod]: (
    ...args: Parameters<PetNoticeLedger[K]>
  ) => ReturnType<PetNoticeLedger[K]> | Promise<Awaited<ReturnType<PetNoticeLedger[K]>>>;
};
