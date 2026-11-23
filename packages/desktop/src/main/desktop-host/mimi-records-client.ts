import type { CallShellBusiness } from "../../shared/shell-business-contracts.js";
import type { MimiRecordCall, MimiRecordDomain, MimiRecords } from "../../shared/mimi-records.js";
import type { PetMemoryStore } from "../pet/pet-memory-store.js";
import type { PetJournalRecord } from "../pet/pet-journal-store.js";

export function nativeMimiRecords(
  business: CallShellBusiness,
  listeners: Set<(domain: MimiRecordDomain) => void>,
) {
  const subscribe = (domain: MimiRecordDomain, callback: () => void) => {
    const listener = (changed: MimiRecordDomain) => {
      if (changed === domain) callback();
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const call = <K extends keyof MimiRecords>(
    action: K,
    args: Parameters<MimiRecords[K]>,
    signal?: AbortSignal,
  ) =>
    business("mimi/records", { action, args } as MimiRecordCall, signal) as Promise<
      ReturnType<MimiRecords[K]>
    >;
  let inboxTail: Promise<unknown> = Promise.resolve();
  const writeInbox = <T>(write: () => Promise<T>) => {
    const result = inboxTail.catch(() => {}).then(write);
    inboxTail = result;
    return result;
  };
  return {
    workInbox: {
      load: () => call("inboxSnapshot", []),
      getSnapshot: () => call("inboxSnapshot", []),
      add: (ids: readonly string[], signal?: AbortSignal) =>
        writeInbox(() => call("inboxAdd", [ids], signal)),
      clear: (signal?: AbortSignal) => writeInbox(() => call("inboxClear", [], signal)),
      addIfAbsentDurably: (id: string) => writeInbox(() => call("inboxClaim", [id])),
      flush: async () => {
        await inboxTail;
      },
      subscribe: (notify: (snapshot: ReturnType<MimiRecords["inboxSnapshot"]>) => void) => {
        let active = true;
        let issued = 0;
        const unsubscribe = subscribe("work-inbox", () => {
          const stamp = ++issued;
          void call("inboxSnapshot", [])
            .then((snapshot) => {
              if (active && stamp === issued) notify(snapshot);
            })
            .catch(() => {});
        });
        return () => {
          active = false;
          unsubscribe();
        };
      },
    },
    metadata: { ensure: () => call("metadata", []) },
    interactive: {
      list: () => call("memoryList", []),
      remember: (text: string, signal?: AbortSignal) => call("remember", [text, "user"], signal),
      update: (id: string, text: string, signal?: AbortSignal) =>
        call("update", [id, text], signal),
      forget: (id: string, signal?: AbortSignal) => call("forget", [id], signal),
      subscribe: (fn: () => void) => subscribe("memories", fn),
    },
    memory: {
      remember: (...args: Parameters<PetMemoryStore["remember"]>) => call("remember", args),
    },
    journal: {
      list: () => call("journalList", []),
      recordedSegmentIds: async () => new Set(await call("journalIds", [])),
      record: (input: PetJournalRecord) => call("record", [input]),
      subscribe: (fn: () => void) => subscribe("journal", fn),
    },
  };
}
