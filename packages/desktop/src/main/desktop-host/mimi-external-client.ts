import type { CallShellBusiness } from "../../shared/shell-business-contracts.js";
import type { ExternalPetSessionSink } from "../pet/external-session-adapter.js";
import { dlog } from "../desktop-logger.js";

/** Native settings changes and Host restarts share the same serialized projection refresh. */
export function nativeMimiExternalActivity(
  call: CallShellBusiness,
  listeners: Set<() => void>,
  projectCwds: () => Promise<string[]>,
  sink: ExternalPetSessionSink,
) {
  const known = new Map<string, string>();
  let tail: Promise<void> = Promise.resolve();
  let current = 0;
  let closed = false;
  let reading = false;
  let dirty = false;
  function clear() {
    for (const id of known.keys()) sink.removeExternalSession(id);
    known.clear();
  }
  function read(scopes: boolean) {
    const captured = current;
    const operation = tail.then(async () => {
      if (closed || captured !== current) return;
      const rows = await call(
        "mimi/externalActivity",
        scopes ? { projectCwds: await projectCwds().catch(() => []) } : {},
      );
      if (closed || captured !== current) return;
      const ids = new Set(rows.map((row) => row.agentSessionId));
      for (const id of known.keys()) {
        if (ids.has(id)) continue;
        known.delete(id);
        sink.removeExternalSession(id);
      }
      for (const row of rows) {
        const value = JSON.stringify(row);
        if (known.get(row.agentSessionId) === value) continue;
        known.set(row.agentSessionId, value);
        sink.upsertExternalSession(row);
      }
    });
    const checked = operation.catch((error) => {
      if (!closed && captured === current) clear();
      throw error;
    });
    tail = checked.catch(() => {});
    return checked;
  }
  function refresh() {
    dirty = true;
    if (reading || closed) return;
    reading = true;
    void (async () => {
      try {
        while (dirty && !closed) {
          dirty = false;
          await read(false);
        }
      } catch (error) {
        dlog("main", "pet.external.refresh.failed", { error: String(error) });
      } finally {
        reading = false;
        if (dirty && !closed) refresh();
      }
    })();
  }
  listeners.add(refresh);
  return {
    reconcile: () => read(true),
    restart() {
      current++;
      clear();
      return read(true);
    },
    shutdown() {
      closed = true;
      listeners.delete(refresh);
    },
  };
}
