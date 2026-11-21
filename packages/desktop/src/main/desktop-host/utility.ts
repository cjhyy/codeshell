import { sessionsRoot } from "@cjhyy/code-shell-core";
import { createSessionIndex } from "@cjhyy/code-shell-server/storage";
import {
  isDesktopHostControl,
  isRpcRequest,
  isRpcResponse,
} from "../../shared/desktop-host-protocol.js";
import { DesktopSessionListVisibility } from "./session-list-visibility.js";
import { DesktopHostServer, desktopHostMethods } from "./server.js";

// Obtain the immutable app version once. There is no generic Electron method
// proxy on the renderer port, and the hosted catalog never waits on Main.
const parent = process.parentPort;
const versionRequestId = "host:app-version";
const index = createSessionIndex(sessionsRoot(), {
  workerUrl: new URL("./session-index-worker.mjs", import.meta.url),
});
const catalog = new DesktopSessionListVisibility(index);
let server: DesktopHostServer | undefined;
let stopping = false;

parent.on("message", ({ data, ports }) => {
  if (stopping) {
    for (const port of ports) port.close();
    return;
  }
  if (isDesktopHostControl(data) && data.type === "bind" && server && ports.length === 1) {
    server.bind(data.identity, ports[0]);
    return;
  }
  for (const port of ports) port.close();
  if (ports.length) return;

  if (isDesktopHostControl(data) && data.type === "shutdown") {
    stopping = true;
    void index.close().finally(() => process.exit(0));
    return;
  }
  if (!server) {
    if (!isRpcResponse(data) || data.id !== versionRequestId) return;
    if (data.error || typeof data.result !== "string" || !data.result) {
      throw new Error("Desktop Host could not read the application version from Main");
    }
    server = new DesktopHostServer(
      data.result,
      desktopHostMethods((options) => catalog.list(options)),
    );
    parent.postMessage({ type: "ready" });
    return;
  }

  if (isRpcRequest(data) && data.method === "host/listDiskSessions") {
    // This pipe is private to Main. Renderer methods use the public view normalizer.
    const params = data.params;
    if (!params || typeof params.limit !== "number") {
      parent.postMessage({
        jsonrpc: "2.0",
        id: data.id,
        error: { code: -32602, message: "Invalid params" },
      });
      return;
    }
    void catalog.list({ ...params, limit: params.limit }).then(
      (result) => {
        if (!stopping) parent.postMessage({ jsonrpc: "2.0", id: data.id, result });
      },
      () => {
        if (!stopping)
          parent.postMessage({
            jsonrpc: "2.0",
            id: data.id,
            error: { code: -32603, message: "Session list failed" },
          });
      },
    );
    return;
  }
  if (!isDesktopHostControl(data)) return;
  switch (data.type) {
    case "session-index-changed":
      for (const id of data.ids) void index.changed(id).catch(() => {});
      break;
    case "revoke":
      server.revoke(data.identity);
      break;
    case "owner":
      server.setOwner(data.sessionId, data.webContentsId);
      break;
    case "deleting":
      server.setDeleting(data.sessionId, data.deleting);
      catalog.setDeleting(data.sessionId, data.deleting);
      break;
  }
});

parent.postMessage({ jsonrpc: "2.0", id: versionRequestId, method: "app/getVersion" });
