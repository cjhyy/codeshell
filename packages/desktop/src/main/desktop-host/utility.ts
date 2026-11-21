import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { ingressMethods } from "./ingress-methods.js";
import { HostApprovalState } from "./approval-state.js";
import { openStateStorage } from "@cjhyy/code-shell-core/internal/storage";
import { taskHostReads } from "../task-inbox/task-host-reads.js";
import { isPrivateTaskCommand } from "../task-inbox/private-task-command.js";
import { HostOutput } from "./host-output.js";
import { outputMethods } from "./output-methods.js";
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
const approvals = new HostApprovalState((id, owner) => server?.allows(id, owner) ?? false);
let stopping = false;
let worker: ReturnType<typeof bindHostWorker> | undefined;
const output = new HostOutput(
  storage,
  (frames) => {
    for (const { envelope } of frames)
      server?.notifySession(envelope.sessionId, "agent/streamEvent", { ...envelope });
    worker?.publish(frames);
  },
  (message, details) => console.warn("[Desktop Host]", message, details),
  (paused) => worker?.pauseOutput(paused),
  (error) => {
    // Storage failure after consuming worker stdout requires a new epoch.
    // The supervisor closes grants and clients recover from their durable cursor.
    console.error("[Desktop Host] Session output storage unavailable", error);
    process.exit(1);
  },
);

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
    worker = bindHostWorker(ports[0], data, {
      output,
      observeWorkerLine: (line) => approvals.observe(line),
      workerExited: (generation) => approvals.reset(generation),
    });
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
    void Promise.all([index.close(), worker?.close()])
      .then(() => output.drain())
      .finally(async () => (await storage).close())
      .then(
        () => process.exit(0),
        () => process.exit(1),
      );
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
        ...ingressMethods(
          (req, current) => {
            if (!worker) throw new Error("Desktop worker is unavailable");
            return worker.rendererCommand(req, current);
          },
          async (id) => {
            if (
              (await catalog.list({ sessionId: id, limit: 1 })).sessions.some(
                (row) => row.id === id,
              )
            )
              return "visible";
            try {
              await lstat(join(sessionsRoot(), id));
              return "hidden";
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
              throw error;
            }
          },
        ),
        ["agent/pendingApprovals", approvals.method] as const,
        ...outputMethods(
          (id, since) => output.snapshot(id, since),
          (options) => catalog.list(options),
        ),
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
  if (isRpcRequest(data) && data.method === "host/readWorkbenchOutput") {
    const { caller, ...params } = data.params ?? {};
    const job = isDesktopHostIdentity(caller)
      ? server.readWorkbenchOutput(caller, params)
      : Promise.reject(new Error("Invalid workbench identity"));
    void job.then(
      (result) => {
        if (!stopping) parent.postMessage({ jsonrpc: "2.0", id: data.id, result });
      },
      () => {
        if (!stopping)
          parent.postMessage({
            jsonrpc: "2.0",
            id: data.id,
            error: { code: -32003, message: "Output access unavailable" },
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
    case "stream-view":
      server.setStreamView(data.sessionId, data.enabled);
      break;
    case "revoke":
      server.revoke(data.identity);
      break;
    case "owner":
      server.setOwner(data.sessionId, data.webContentsId);
      break;
    case "deleting":
      if (data.deleting) approvals.forgetSession(data.sessionId);
      server.setDeleting(data.sessionId, data.deleting);
      catalog.setDeleting(data.sessionId, data.deleting);
      break;
  }
});

parent.postMessage({ jsonrpc: "2.0", id: versionRequestId, method: "app/getVersion" });
