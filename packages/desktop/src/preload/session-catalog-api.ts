import type { IpcRenderer, IpcRendererEvent } from "electron";
import type { SessionCatalogApi, SessionCatalogSnapshot } from "../shared/session-catalog";

/** The renderer keeps a projection; Main acknowledges every durable edit. */
export function createSessionCatalogApi(
  ipc: Pick<IpcRenderer, "invoke" | "on" | "removeListener">,
): SessionCatalogApi {
  const flushListeners = new Set<() => Promise<void>>();
  const waitingForRenderer = new Set<string>();
  const flush = (requestId: string) => {
    if (!flushListeners.size) {
      waitingForRenderer.add(requestId);
      return;
    }
    void Promise.all([...flushListeners].map((listener) => Promise.resolve().then(listener)))
      .then(
        () => ipc.invoke("sessionCatalog:flushComplete", { requestId, ok: true }),
        () => ipc.invoke("sessionCatalog:flushComplete", { requestId, ok: false }),
      )
      .catch(() => undefined);
  };
  // A reopened workbench can receive Quit before React mounts its persistence gate.
  ipc.on("sessionCatalog:flushRequested", (_event: IpcRendererEvent, requestId: string) =>
    flush(requestId),
  );
  return {
    load: () => ipc.invoke("sessionCatalog:load"),
    importLegacy: (indices) => ipc.invoke("sessionCatalog:importLegacy", indices),
    apply: (patch) => ipc.invoke("sessionCatalog:apply", patch),
    writeTranscript: (input) => ipc.invoke("sessionCatalog:writeTranscript", input),
    readTranscript: (input) => ipc.invoke("sessionCatalog:readTranscript", input),
    deleteTranscript: (input) => ipc.invoke("sessionCatalog:deleteTranscript", input),
    onFlushRequested(listener) {
      const save = () => listener();
      flushListeners.add(save);
      for (const requestId of waitingForRenderer) flush(requestId);
      waitingForRenderer.clear();
      return () => {
        flushListeners.delete(save);
      };
    },
    onChanged(listener) {
      const handler = (_event: IpcRendererEvent, snapshot: SessionCatalogSnapshot) =>
        listener(snapshot);
      ipc.on("sessionCatalog:changed", handler);
      return () => ipc.removeListener("sessionCatalog:changed", handler);
    },
  };
}
