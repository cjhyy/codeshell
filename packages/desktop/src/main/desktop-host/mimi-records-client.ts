import type { CallShellBusiness } from "../../shared/shell-business-contracts.js";
import type { MimiRecordCall, MimiRecordDomain, MimiRecords } from "../../shared/mimi-records.js";
import type { PetMemoryStore } from "../pet/pet-memory-store.js";
import type { PetJournalRecord } from "../pet/pet-journal-store.js";
import type { PetHostActionContext, PetWorldContextInput } from "../pet/pet-dispatch-service.js";
import type { MobileRemoteGatewayStatus } from "../im-gateway-control-server.js";
import { petRemoteMemoryContext } from "../pet/pet-memory-host.js";

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
    memoryAction: (payload: Record<string, unknown>, ctx?: PetHostActionContext) =>
      call("memoryAction", [
        payload,
        ctx && { originRef: ctx.originRef, groundedTasks: ctx.groundedTasks },
      ]),
    worldContext: async (input: PetWorldContextInput, remote: MobileRemoteGatewayStatus) => ({
      ...(await call("memoryRecall", [
        {
          message: input.message,
          originRef: input.originRef,
          groundedObjectives: input.groundedTasks.map((t) => t.objective),
          taskIds: input.groundedTasks.map((t) => t.taskId),
        },
      ])),
      mobileRemote: petRemoteMemoryContext(remote),
    }),
    journal: {
      list: () => call("journalList", []),
      recordedSegmentIds: async () => new Set(await call("journalIds", [])),
      record: (input: PetJournalRecord) => call("record", [input]),
      subscribe: (fn: () => void) => subscribe("journal", fn),
    },
  };
}
