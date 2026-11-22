import { labFiles } from "../../host/composition/optimization-lab.js";
import { configuredMcpProbe } from "../../host/composition/configured-mcp-probe.js";
import { parseMimiSegmentRange } from "../../shared/mimi-records.js";
import { hostedMimiSegments } from "../../host/composition/mimi-segments.js";
import { hostedSkills } from "../../host/composition/skills.js";
import { wechatLoginOperations } from "../../host/composition/wechat-login.js";
import { bindExternalProvider } from "../../host/composition/external-provider.js";
import { electronPrivatePort } from "../../host/native-peer.js";
import { mimiWorkView, type MimiWorkSnapshot } from "../../shared/mimi-work-memory.js";
import { ccRoomReads } from "../../host/composition/cc-room-reads.js";
import { hostedMediaProtocol } from "../../host/composition/media-protocol.js";
import { attachmentOperations } from "../../host/composition/attachments.js";
import { hostedActivityHistory } from "../../host/composition/activity-history.js";
import { ActivityHistoryWorker } from "../activity-history-worker-client.js";
import { memoryReads } from "./memory-reads.js";
import { memoryOperations } from "../../host/composition/memory.js";
import { bindImGateway } from "../../host/im/gateway.js";
import { bindRemoteServices } from "../../host/remote/service.js";
import { bindRemoteTerminals } from "../../host/composition/remote-terminals.js";
import { hostedTerminals } from "../../host/composition/terminals.js";
import { mimiRecordsOperations, readMimiList } from "../../host/composition/mimi-records.js";
import { HostScheduler } from "../../host/automation/host-scheduler.js";
import { installDefaultLinkProviders } from "@cjhyy/code-shell-server/links";
import { workspaceReads } from "./workspace-reads.js";
import { HostAutomationRuns } from "../../host/composition/automation-run.js";
import { externalRuntimeCatalogOperations } from "../../host/composition/external-runtime-catalog.js";
import { MessageChannel, Worker } from "node:worker_threads";
import { SessionTranscriptCache } from "../session-transcript-cache.js";
import type { BusinessMethods } from "../../host/composition/business-calls.js";
import { RunKeyClient } from "./run-key-client.js";
import { HostRunOperations } from "../../host/composition/run-operations.js";
import { nativeOperations } from "../../host/composition/operations.js";
import { HostBusinessCalls } from "../../host/composition/business-calls.js";
import { catalogEdits } from "../../host/composition/catalog-edits.js";
import { projectRegistryOperations } from "../../host/composition/project-registry.js";
import { projectTrustOperations } from "../../host/composition/project-trust.js";
import { catalogOperations } from "../../host/composition/session-catalog.js";
import { businessRead, noBusinessArguments } from "./business-read.js";
import { settingsOperations } from "../../host/composition/settings.js";
import { scopedConfigurationReads } from "./scoped-configuration-reads.js";
import { configurationReads } from "./configuration-reads.js";
import { isDesktopAgentMethod } from "../../shared/desktop-agent-methods.js";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { ingressMethods } from "./ingress-methods.js";
import { HostApprovalState } from "./approval-state.js";
import {
  credentialCommands,
  type CredentialFileCommand,
  openStateStorage,
} from "@cjhyy/code-shell-core/internal/storage";
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
import {
  DesktopHostServer,
  desktopHostMethods,
  WorkerCommandError,
  InvalidParams,
} from "./server.js";

// Obtain the immutable app version once. There is no generic Electron method
// proxy on the renderer port, and the hosted catalog never waits on Main.
const parent = process.parentPort;
const versionRequestId = "host:app-version";
const schedulerPorts = new MessageChannel();
const storage = openStateStorage(sessionsRoot(), {
  workerConfig: { taskInboxDirectory: process.argv[2], schedulerPort: schedulerPorts.port2 },
  workerPorts: [schedulerPorts.port2],
  workerUrl: new URL("./session-index-worker.mjs", import.meta.url),
});
const catalogFiles = catalogOperations(storage, (snapshot) =>
  parent.postMessage({ type: "session-catalog-changed", snapshot }),
);
const transcripts = new SessionTranscriptCache(
  {},
  (options) =>
    new Worker(new URL("./session-transcript-cache-worker.mjs", import.meta.url), {
      workerData: options,
    }),
);
const runKeys = new RunKeyClient((frame) => parent.postMessage(frame));
const runOperations = new HostRunOperations(
  storage,
  (create) => runKeys.request(create),
  (sessionId) => {
    if (!server) throw new Error("Host unavailable");
    return server.captureWorkerOperation(sessionId);
  },
);
const operations = nativeOperations(storage, () => server);
const automation = new HostAutomationRuns({
  operations: runOperations,
  notice: (notice) => parent.postMessage({ type: "automation-notice", notice }),
  share: (id, enabled) => server?.setStreamView(id, enabled),
  publish: (sessionId, event) => {
    void output
      .mutate({ type: "publish", sessionId, event, visibility: "hidden" })
      .catch((error) => {
        console.error("[Desktop Host] Automation output storage unavailable", error);
        process.exit(1);
      });
  },
  drain: () => output.drain(),
});
const scheduler = new HostScheduler(schedulerPorts.port1, automation);
// Link-backed source definitions are validated against this process-local registry.
installDefaultLinkProviders();
const historyWorker = new ActivityHistoryWorker(
  { sessionsDir: sessionsRoot(), roomsDir: join(process.argv[2], "..", "mobile-remote", "rooms") },
  (options) =>
    new Worker(new URL("./activity-history-worker.mjs", import.meta.url), { workerData: options }),
);
historyWorker.onExternalActivityChanged = () => parent.postMessage({ type: "mimi-external-changed" });
const activities = hostedActivityHistory(historyWorker);
const roomReads = ccRoomReads(historyWorker);
const mediaProtocol = hostedMediaProtocol();
const segments = hostedMimiSegments(storage, historyWorker, (domain) =>
  parent.postMessage({ type: "mimi-records-changed", domain }),
);
const skills = hostedSkills(new URL("./skill-worker.mjs", import.meta.url));
let server: DesktopHostServer | undefined;
const approvals = new HostApprovalState((id, owner) => server?.allows(id, owner) ?? false);
const business = new HostBusinessCalls({
  ...approvals.native,
  ...segments,
  "rooms/messages": (p) => historyWorker.roomHistory("rooms/messages", p),
  "rooms/historyPage": (p) => historyWorker.roomHistory("rooms/historyPage", p),
  ...labFiles,
  ...skills.methods,
  ...configuredMcpProbe,
  ...wechatLoginOperations((event) => parent.postMessage({ type: "wechat-login-event", event })),
  "mimi/externalActivity": (input) => historyWorker.mimiExternalActivity(input),
  ...mimiRecordsOperations(storage, (domain) =>
    parent.postMessage({ type: "mimi-records-changed", domain }),
  ),
  ...mediaProtocol.methods,
  ...activities.operations,
  ...attachmentOperations,
  "automation/command": (cmd, grant) => scheduler.command(cmd, grant.permit, grant.signal),
  ...externalRuntimeCatalogOperations(),
  ...roomReads.native,
  ...catalogFiles,
  "transcripts/read": (input) => transcripts.read(input),
  "transcripts/write": (input, grant) => transcripts.commitWrite(input, grant.permit),
  "transcripts/delete": (input, grant) => transcripts.commitDelete(input, grant.permit),
  ...operations.methods,
  ...catalogEdits(storage),
  ...memoryOperations(storage),
  ...projectTrustOperations(storage),
  ...projectRegistryOperations(storage, (requestId, projects) =>
    parent.postMessage({ type: "project-registry-committed", requestId, projects }),
  ),
  ...settingsOperations(storage, (requestId, effects) =>
    parent.postMessage({ type: "settings-committed", requestId, effects }),
  ),
} satisfies BusinessMethods);
const index = createSessionIndex(sessionsRoot(), { storage });
const catalog = new DesktopSessionListVisibility(index);
const terminals = hostedTerminals(
  () => server!,
  (options) => catalog.list(options),
);
let im: ReturnType<typeof bindImGateway> | undefined;
let remote: ReturnType<typeof bindRemoteServices> | undefined;
let stopping = false;
const providers = new Set<() => Promise<void>>();
let closeRemoteTerminals: (() => void) | undefined;
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
  if (isDesktopHostControl(data) && data.type === "im-gateway-port" && server && ports.length === 1 && !im) {
    im = bindImGateway(electronPrivatePort(ports[0]));
    return;
  }
  if (isDesktopHostControl(data) && data.type === "external-provider-port" && server && ports.length === 1) {
    if (providers.size >= 128) {
      ports[0].close();
      return;
    }
    const dispose = bindExternalProvider(electronPrivatePort(ports[0]), () => providers.delete(dispose));
    providers.add(dispose);
    return;
  }
  if (
    isDesktopHostControl(data) &&
    data.type === "remote-terminal-port" &&
    server &&
    ports.length === 1
  ) {
    closeRemoteTerminals?.();
    closeRemoteTerminals = bindRemoteTerminals(ports[0]);
    return;
  }
  if (
    isDesktopHostControl(data) &&
    data.type === "remote-services-port" &&
    server &&
    ports.length === 1 &&
    !remote
  ) {
    remote = bindRemoteServices(electronPrivatePort(ports[0]), join(process.argv[2], ".."));
    return;
  }
  if (
    isDesktopHostControl(data) &&
    data.type === "automation-port" &&
    server &&
    ports.length === 1
  ) {
    scheduler.bind(electronPrivatePort(ports[0]), data.searchPath);
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
      runOperations,
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
    closeRemoteTerminals?.();
    terminals.close();
    runKeys.close();
    runOperations.close();
    business.close();
    void scheduler
      .close()
      .then(() =>
        Promise.all([
          index.close(),
          historyWorker.close(),
          skills.close(),
          worker?.close(),
          transcripts.close(),
          automation.close(),
          ...[...providers].map((close) => close()),
          remote?.close(),
          im?.close(),
          mediaProtocol.close(),
        ]),
      )
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
        businessRead("mimi/workInbox", noBusinessArguments, () => readMimiList(storage,"inboxSnapshot")),
        businessRead("mimi/segmentMessages", parseMimiSegmentRange, (range) =>
          segments["mimi/segmentMessages"](range),
        ),
        businessRead("mimi/workMemory", noBusinessArguments, async () => {
          const snapshot = await (
            await storage
          ).request<MimiWorkSnapshot>("mimi/workMemory", { type: "snapshot" });
          if (!snapshot) throw Error("Mimi work memory unavailable");
          return mimiWorkView(snapshot.segments);
        }),
        businessRead("mimi/memories", noBusinessArguments, () =>
          readMimiList(storage, "memoryList"),
        ),
        businessRead("mimi/journal", noBusinessArguments, () =>
          readMimiList(storage, "journalList"),
        ),
        ...terminals.methods,
        ...roomReads.methods,
        ...configurationReads,
        ...memoryReads,
        ...activities.reads,
        ...scopedConfigurationReads((options) => catalog.list(options)),
        ...workspaceReads((options) => catalog.list(options)),
        businessRead("catalog/load", noBusinessArguments, catalogFiles["catalog/load"]),
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
      () => {
        operations.authorityChanged();
        runOperations.authorityChanged();
      },
    );
    parent.postMessage({ type: "ready" });
    return;
  }

  if (runKeys.receive(data)) return;
  if (
    isRpcRequest(data) &&
    data.method === "host/readOperationWrappedKey" &&
    Object.keys(data.params ?? {}).length === 0
  ) {
    void storage
      .then((db) => db.request<string>("operations/wrappedKey"))
      .then(
        (result) => parent.postMessage({ jsonrpc: "2.0", id: data.id, result }),
        () =>
          parent.postMessage({
            jsonrpc: "2.0",
            id: data.id,
            error: { code: -32603, message: "Operation key unavailable" },
          }),
      );
    return;
  }
  if (data?.type === "withdraw-business" && typeof data.id === "string") {
    business.revoke(data.id);
    return;
  }
  if (isRpcRequest(data) && data.method === "host/business" && typeof data.id === "string") {
    const { id, params } = data;
    void business.run(id, String(params?.method), params?.input).then(
      (result) => {
        if (!stopping) parent.postMessage({ jsonrpc: "2.0", id, result });
      },
      (error) => {
        if (!stopping)
          parent.postMessage({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : "Business operation failed",
            },
          });
      },
    );
    return;
  }
  if (
    isRpcRequest(data) &&
    (isPrivateTaskCommand(data.method) ||
      credentialCommands.includes(data.method as CredentialFileCommand))
  ) {
    const { id, method, params } = data;
    const host = server;
    const invoke = async () => {
      const db = await storage;
      if (credentialCommands.includes(method as CredentialFileCommand)) {
        if (!params?.caller) return db.request(method, { payload: params?.payload });
        if (!isDesktopHostIdentity(params.caller)) throw new Error("Invalid credential caller");
        const reservation = host.reserveDocumentCommit(params.caller);
        try {
          return await db.request(method, { payload: params.payload, permit: reservation.permit });
        } finally {
          reservation.release();
        }
      }
      if (method !== "tasks/intent" || !params?.caller) return db.request(method, params?.payload);
      if (!isDesktopHostIdentity(params.caller)) throw new Error("Invalid task caller");
      const reservation = host.reserveDocumentCommit(params.caller);
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
  if (isRpcRequest(data) && data.method === "host/workbenchCommand") {
    const { caller, method, params } = data.params ?? {};
    const job =
      isDesktopHostIdentity(caller) &&
      isDesktopAgentMethod(method) &&
      params &&
      typeof params === "object" &&
      !Array.isArray(params)
        ? server.readWorkbenchOutput(caller, params as Record<string, unknown>, method)
        : Promise.reject(new Error("Invalid workbench command"));
    void job.then(
      (result) => {
        if (!stopping) parent.postMessage({ jsonrpc: "2.0", id: data.id, result });
      },
      (error) => {
        if (!stopping)
          parent.postMessage({
            jsonrpc: "2.0",
            id: data.id,
            error:
              error instanceof WorkerCommandError
                ? error.rpcError
                : {
                    code: error instanceof InvalidParams ? -32602 : -32010,
                    message: error instanceof Error ? error.message : "Command unavailable",
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
    case "window-closed":
      terminals.closeWindow(data.webContentsId);
      break;
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
