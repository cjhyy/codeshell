/**
 * Preload — exposes a minimal IPC surface to the renderer via
 * contextBridge. The renderer never sees ipcRenderer directly so
 * contextIsolation stays meaningful.
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
  onRpc(listener: Listener): (event: unknown, msg: RpcMessage) => void {
    const wrapped = (_event: unknown, msg: RpcMessage): void => listener(msg);
    ipcRenderer.on(RPC_TO_RENDERER, wrapped);
    return wrapped;
  },
  removeRpcListener(wrapped: (event: unknown, msg: RpcMessage) => void): void {
    ipcRenderer.removeListener(RPC_TO_RENDERER, wrapped);
  },
});
