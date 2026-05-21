/**
 * Preload — runs in an isolated context with both Node and DOM access.
 *
 * We expose a tiny IPC bridge that the renderer wraps in IpcTransport.
 * Keeping the surface minimal (sendRpc + onRpc + removeRpcListener) means
 * the renderer never gains direct access to ipcRenderer or any Node API,
 * which is required when contextIsolation: true.
 */

import { contextBridge, ipcRenderer } from "electron";

const RPC_FROM_RENDERER = "code-shell:rpc:to-main";
const RPC_TO_RENDERER = "code-shell:rpc:to-renderer";

type RpcMessage = unknown;
type Listener = (msg: RpcMessage) => void;

contextBridge.exposeInMainWorld("codeShell", {
  sendRpc(msg: RpcMessage): void {
    ipcRenderer.send(RPC_FROM_RENDERER, msg);
  },

  /**
   * Subscribe to inbound RPC messages. Returns the underlying wrapper
   * so removeRpcListener can detach it. We don't expose ipcRenderer
   * itself across the contextBridge — only this single function pair.
   */
  onRpc(listener: Listener): (event: unknown, msg: RpcMessage) => void {
    const wrapped = (_event: unknown, msg: RpcMessage): void => listener(msg);
    ipcRenderer.on(RPC_TO_RENDERER, wrapped);
    return wrapped;
  },

  removeRpcListener(wrapped: (event: unknown, msg: RpcMessage) => void): void {
    ipcRenderer.removeListener(RPC_TO_RENDERER, wrapped);
  },
});
