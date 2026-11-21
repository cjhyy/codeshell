import type { CallShellBusiness } from "../../shared/shell-business-contracts.js";
import type {
  SessionCatalogApi,
  SessionCatalogSnapshot,
  SessionIndex,
  SessionCatalogPatch,
} from "../../shared/session-catalog.js";

/** The shutdown barrier also includes edits submitted by windows that have
 * already closed. Host replies acknowledge the file mutex and atomic rename. */
export function hostCatalogClient(
  call: CallShellBusiness,
  listeners: Set<(snapshot: SessionCatalogSnapshot) => void>,
) {
  const pending = new Set<Promise<unknown>>();
  function track<T>(job: Promise<T>) {
    pending.add(job);
    return job.finally(() => pending.delete(job));
  }
  const flush = async () => {
    await Promise.all([...pending]);
  };
  return {
    transcripts: {
      read: (input: Parameters<SessionCatalogApi["readTranscript"]>[0], signal?: AbortSignal) =>
        call("transcripts/read", input, signal),
      write: (input: Parameters<SessionCatalogApi["writeTranscript"]>[0], signal?: AbortSignal) =>
        track(call("transcripts/write", input, signal)),
      delete: (input: Parameters<SessionCatalogApi["deleteTranscript"]>[0], signal?: AbortSignal) =>
        track(call("transcripts/delete", input, signal)),
      flush,
      close: flush,
    },
    load: (signal?: AbortSignal) => call("catalog/load", undefined, signal),
    importLegacy: (value: Record<string, SessionIndex>, signal?: AbortSignal) =>
      track(call("catalog/importLegacy", value, signal)),
    apply: (patch: SessionCatalogPatch, signal?: AbortSignal) =>
      track(call("catalog/apply", patch, signal)),
    onChanged(listener: (snapshot: SessionCatalogSnapshot) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    flush,
  };
}
