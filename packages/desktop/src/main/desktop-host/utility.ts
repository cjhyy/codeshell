import { openStateStorage } from "@cjhyy/code-shell-core/internal/storage";
import { taskHostReads } from "../task-inbox/task-host-reads.js";
import { isPrivateTaskCommand } from "../task-inbox/private-task-command.js";
import { bindHostWorker } from "./host-worker.js";
import { sessionsRoot } from "@cjhyy/code-shell-core";
import { createSessionIndex } from "@cjhyy/code-shell-server/storage";
import {
  isDesktopHostControl,
  isDesktopHostIdentity,
  isRpcRequest,
  isRpcResponse,
} from "../../shared/desktop-host-protocol.js";
import { DesktopSessionListVisibility } from "./session-list-visibility.js";
import { DesktopHostServer, desktopHostMethods } from "./server.js";

// Obtain the immutable app version once. There is no generic Electron method
// proxy on the renderer port, and the hosted catalog never waits on Main.
const parent = process.parentPort;
const versionRequestId = "host:app-version";
const storage = openStateStorage(sessionsRoot(), {
  workerConfig: { taskInboxDirectory: process.argv[2] },
  workerUrl: new URL("./session-index-worker.mjs", import.meta.url),
});
const index = createSessionIndex(sessionsRoot(), { storage });
const catalog = new DesktopSessionListVisibility(index);
let server: DesktopHostServer | undefined;
let stopping = false;
let worker: ReturnType<typeof bindHostWorker> | undefined;

parent.on("message", ({ data, ports }) => {
  if (stopping) {
    for (const port of ports) port.close();
    return;
  }
  if (
    isDesktopHostControl(data) &&
    data.type === "worker-port" &&
    server &&
    ports.length === 1 &&
    !worker
  ) {
    worker = bindHostWorker(ports[0], data);
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
    void Promise.all([index.close(), worker?.close()]).finally(async () => (await storage).close()).then(
      () => process.exit(0), () => process.exit(1));
    return;
  }
  if (!server) {
    if (!isRpcResponse(data) || data.id !== versionRequestId) return;
    if (data.error || typeof data.result !== "string" || !data.result) {
      throw new Error("Desktop Host could not read the application version from Main");
    }
    server = new DesktopHostServer(
      data.result,
      new Map([
        ...desktopHostMethods((options) => catalog.list(options)),
        ...taskHostReads(storage),
      ]),
    );
    parent.postMessage({ type: "ready" });
    return;
  }

  if (isRpcRequest(data) && isPrivateTaskCommand(data.method)) {
    const { id, method, params } = data;
    const host = server;
    const invoke = async () => {
      const db = await storage;
      if (method !== "tasks/intent" || !params?.caller) return db.request(method, params?.payload);
      if (!isDesktopHostIdentity(params.caller)) throw new Error("Invalid task caller");
      const reservation = host.reserveTaskCommit(params.caller);
      try {
        return await db.request("tasks/commitIntent", {
          intent: params.payload,
          permit: reservation.permit,
        });
      } finally {
        reservation.release();
      }
    };
    void invoke().then(
      (result) => {
        if (!stopping) parent.postMessage({ jsonrpc: "2.0", id, result });
      },
      (error: unknown) => {
        if (!stopping)
          parent.postMessage({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : "Task operation failed",
            },
          });
      },
    );
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
