import { AsyncLocalStorage } from "node:async_hooks";
import type { MimiRuleCall, MimiRuleMethod, PetRuleAccess } from "../../shared/mimi-rules.js";
import type { CallShellBusiness } from "../../shared/shell-business-contracts.js";
import { PetRuleStoreError, type PetRuleStore } from "../pet/pet-rule-store.js";

const documents = new AsyncLocalStorage<AbortSignal>();
export const currentMimiRuleDocument = () => documents.getStore();
export function withMimiRuleDocument<T>(signal: AbortSignal | undefined, work: () => T): T {
  if (!signal) return work();
  signal.throwIfAborted();
  return documents.run(signal, work);
}

/** Reads fetch the current owner's state. Reconnection only invalidates observers. */
export function nativeMimiRules(call: CallShellBusiness) {
  const listeners = new Set<() => void>();
  const invalidate = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* A consumer cannot undo a committed change. */
      }
    }
  };
  const method =
    <K extends MimiRuleMethod>(name: K) =>
    async (...args: Parameters<PetRuleStore[K]>): Promise<Awaited<ReturnType<PetRuleStore[K]>>> => {
      const response = await call(
        "mimi/rules",
        { method: name, args } as MimiRuleCall,
        currentMimiRuleDocument(),
      );
      if (!response.ok) throw new PetRuleStoreError(response.code);
      if (response.changed) documents.exit(invalidate);
      return response.value as Awaited<ReturnType<PetRuleStore[K]>>;
    };
  const rules = {
    load: method("load"),
    flush: method("flush"),
    list: method("list"),
    get: method("get"),
    activeForSession: method("activeForSession"),
    systemRule: method("systemRule"),
    upsertSessionRule: method("upsertSessionRule"),
    update: method("update"),
    createScheduleRule: method("createScheduleRule"),
    rescheduleRule: method("rescheduleRule"),
    claimOccurrence: method("claimOccurrence"),
    settleOccurrence: method("settleOccurrence"),
    recoverClaims: method("recoverClaims"),
    setSystemSchedule: method("setSystemSchedule"),
    setSystemRule: method("setSystemRule"),
    onChange(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } satisfies PetRuleAccess;
  return { rules, invalidate };
}
