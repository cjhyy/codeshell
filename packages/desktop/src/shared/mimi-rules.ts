import type { PetRuleStore, PetRuleStoreErrorCode } from "../main/pet/pet-rule-store.js";

/** Mutations, version checks and occurrence claims run on the single rules.json owner. */
export const mimiRuleMethods = [
  "load",
  "flush",
  "list",
  "get",
  "activeForSession",
  "systemRule",
  "upsertSessionRule",
  "update",
  "createScheduleRule",
  "rescheduleRule",
  "claimOccurrence",
  "settleOccurrence",
  "recoverClaims",
  "setSystemSchedule",
  "setSystemRule",
] as const satisfies readonly (keyof PetRuleStore)[];
export type MimiRuleMethod = (typeof mimiRuleMethods)[number];
type RuleRead = "list" | "get" | "activeForSession" | "systemRule";
export type PetRuleAccess = Pick<PetRuleStore, Exclude<MimiRuleMethod, RuleRead> | "onChange"> & {
  [K in RuleRead]: (
    ...args: Parameters<PetRuleStore[K]>
  ) => ReturnType<PetRuleStore[K]> | Promise<ReturnType<PetRuleStore[K]>>;
};
export type MimiRuleCall = {
  [K in MimiRuleMethod]: { method: K; args: Parameters<PetRuleStore[K]> };
}[MimiRuleMethod];
export type MimiRuleReply =
  | { ok: true; value: unknown; changed: boolean }
  | { ok: false; code: PetRuleStoreErrorCode };
