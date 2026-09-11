import type { IpcRenderer, IpcRendererEvent } from "electron";
import type { SessionCatalogApi, SessionCatalogSnapshot } from "../shared/session-catalog";

/** The renderer keeps a projection; Main acknowledges every durable edit. */
export function createSessionCatalogApi(
  ipc: Pick<IpcRenderer, "invoke" | "on" | "removeListener">,
): SessionCatalogApi {
  return {
    load: () => ipc.invoke("sessionCatalog:load"),
    importLegacy: (indices) => ipc.invoke("sessionCatalog:importLegacy", indices),
    apply: (patch) => ipc.invoke("sessionCatalog:apply", patch),
    writeTranscript: (input) => ipc.invoke("sessionCatalog:writeTranscript", input),
    readTranscript: (input) => ipc.invoke("sessionCatalog:readTranscript", input),
    deleteTranscript: (input) => ipc.invoke("sessionCatalog:deleteTranscript", input),
    onFlushRequested(listener) {
      const handler = (_event: IpcRendererEvent, requestId: string) => {
        void Promise.resolve()
          .then(listener)
          .then(
            () => ipc.invoke("sessionCatalog:flushComplete", { requestId, ok: true }),
            () => ipc.invoke("sessionCatalog:flushComplete", { requestId, ok: false }),
          )
          .catch(() => undefined);
      };
      ipc.on("sessionCatalog:flushRequested", handler);
      return () => ipc.removeListener("sessionCatalog:flushRequested", handler);
    },
    onChanged(listener) {
      const handler = (_event: IpcRendererEvent, snapshot: SessionCatalogSnapshot) =>
        listener(snapshot);
      ipc.on("sessionCatalog:changed", handler);
      return () => ipc.removeListener("sessionCatalog:changed", handler);
    },
  };
}
