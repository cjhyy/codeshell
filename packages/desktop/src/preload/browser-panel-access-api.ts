import type { IpcRenderer, IpcRendererEvent } from "electron";

/** The agent asks to drive the BrowserPanel tab; the panel shows Allow / Deny. */
export interface BrowserPanelAccessPrompt {
  requestId: string;
  sessionId: string;
  /** Exact Main-owned WebContents identity; match this before showing Allow. */
  guestId: number;
  url: string;
  title: string;
  /** Epoch ms after which main treats the request as declined. */
  expiresAt: number;
}

export interface BrowserPanelAccessApi {
  /** Subscribe to access requests. Returns unsubscribe. */
  onRequest(cb: (prompt: BrowserPanelAccessPrompt) => void): () => void;
  /** Answer after the user clicks. Allow must follow a successful tab grant. */
  respond(requestId: string, granted: boolean): void;
}

export function createBrowserPanelAccessApi(
  ipc: Pick<IpcRenderer, "on" | "removeListener" | "send">,
): BrowserPanelAccessApi {
  return {
    onRequest: (cb) => {
      const h = (_e: IpcRendererEvent, prompt: BrowserPanelAccessPrompt) => cb(prompt);
      ipc.on("browser:panel-access-request", h);
      return () => ipc.removeListener("browser:panel-access-request", h);
    },
    respond: (requestId, granted) =>
      ipc.send("browser:panel-access-response", { requestId, granted }),
  };
}
