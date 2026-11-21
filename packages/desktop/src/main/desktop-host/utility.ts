import { isDesktopHostControl, isRpcResponse } from "../../shared/desktop-host-protocol.js";
import { DesktopHostServer } from "./server.js";

// Obtain the immutable app version once. There is no generic Electron method
// proxy on the renderer port, and the hosted catalog never waits on Main.
const parent = process.parentPort;
const versionRequestId = "host:app-version";
let server: DesktopHostServer | undefined;

parent.on("message", ({ data, ports }) => {
  if (isDesktopHostControl(data) && data.type === "bind" && server && ports.length === 1) {
    server.bind(data.identity, ports[0]);
    return;
  }
  for (const port of ports) port.close();
  if (ports.length) return;

  if (!server) {
    if (!isRpcResponse(data) || data.id !== versionRequestId) return;
    if (data.error || typeof data.result !== "string" || !data.result) {
      throw new Error("Desktop Host could not read the application version from Main");
    }
    server = new DesktopHostServer(data.result);
    parent.postMessage({ type: "ready" });
    return;
  }

  if (!isDesktopHostControl(data)) return;
  switch (data.type) {
    case "revoke":
      server.revoke(data.identity);
      break;
    case "owner":
      server.setOwner(data.sessionId, data.webContentsId);
      break;
    case "deleting":
      server.setDeleting(data.sessionId, data.deleting);
      break;
  }
});

parent.postMessage({ jsonrpc: "2.0", id: versionRequestId, method: "app/getVersion" });
