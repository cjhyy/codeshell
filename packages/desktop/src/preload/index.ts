/**
 * Preload — bridges the renderer (browser context) to Electron main's
 * ipcMain via contextBridge. The renderer never imports core; it sees
 * only the typed `window.codeshell` surface defined here.
 *
 * Wire format on the IPC channel "agent:msg" is the full JSON-RPC
 * line (string) we relay verbatim to/from the agent worker's stdio.
 * That keeps the preload a true transparent transport — no protocol
 * interpretation in main, only in here (to fan out to listeners).
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

let nextRpcId = 1;
const pending = new Map<number, (resp: unknown) => void>();
const streamListeners: Array<(event: unknown) => void> = [];
const approvalListeners: Array<(req: unknown) => void> = [];
const statusListeners: Array<(evt: unknown) => void> = [];
const lifecycleListeners: Array<(evt: unknown) => void> = [];

ipcRenderer.on("agent:msg", (_e: IpcRendererEvent, line: string) => {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return; // malformed — skip
  }
  // Response: has id, no method
  if ("id" in msg && !("method" in msg)) {
    const id = msg.id as number;
    const resolver = pending.get(id);
    if (resolver) {
      pending.delete(id);
      resolver(msg);
    }
    return;
  }
  // Notification: has method
  const method = msg.method as string | undefined;
  const params = msg.params as Record<string, unknown> | undefined;
  if (method === "agent/streamEvent") {
    // Worker wire format wraps the event: { params: { event: {...} } }.
    // Strip that wrapper so renderer callbacks see the StreamEvent directly,
    // matching the typed `onStreamEvent(cb: (event: StreamEvent) => void)`
    // signature.
    const event = params?.event;
    streamListeners.forEach((cb) => cb(event));
  } else if (method === "agent/approvalRequest") {
    // Approval keeps the full envelope { requestId, request } intentionally —
    // the renderer needs requestId to echo back via approve().
    approvalListeners.forEach((cb) => cb(params));
  } else if (method === "agent/status") {
    statusListeners.forEach((cb) => cb(params));
  }
});

ipcRenderer.on("agent:lifecycle", (_e: IpcRendererEvent, evt: unknown) => {
  lifecycleListeners.forEach((cb) => cb(evt));
});

function rpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
  const id = nextRpcId++;
  const line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ipcRenderer.send("agent:msg", line);
  });
}

contextBridge.exposeInMainWorld("codeshell", {
  /** Forward a renderer-side log line into ~/.code-shell/logs/desktop-*.log. */
  log: (msg: string, data?: Record<string, unknown>) =>
    ipcRenderer.send("desktop:log", { msg, data }),
  run: (task: string, opts?: { cwd?: string; sessionId?: string } & Record<string, unknown>) =>
    rpc("agent/run", { task, ...(opts ?? {}) }),
  cancel: () => rpc("agent/cancel"),
  approve: (requestId: string, decision: "approve" | "deny", reason?: string) =>
    rpc("agent/approve", {
      requestId,
      decision: decision === "approve"
        ? { approved: true }
        : { approved: false, reason },
    }),
  onStreamEvent: (cb: (event: unknown) => void): (() => void) => {
    streamListeners.push(cb);
    return () => {
      const i = streamListeners.indexOf(cb);
      if (i >= 0) streamListeners.splice(i, 1);
    };
  },
  onApprovalRequest: (cb: (req: unknown) => void): (() => void) => {
    approvalListeners.push(cb);
    return () => {
      const i = approvalListeners.indexOf(cb);
      if (i >= 0) approvalListeners.splice(i, 1);
    };
  },
  onStatus: (cb: (evt: unknown) => void): (() => void) => {
    statusListeners.push(cb);
    return () => {
      const i = statusListeners.indexOf(cb);
      if (i >= 0) statusListeners.splice(i, 1);
    };
  },
  onAgentLifecycle: (cb: (evt: unknown) => void): (() => void) => {
    lifecycleListeners.push(cb);
    return () => {
      const i = lifecycleListeners.indexOf(cb);
      if (i >= 0) lifecycleListeners.splice(i, 1);
    };
  },
});
