import { transcriptContextOperation } from "../../host/composition/transcript-context.js";
import { sessionFileOperations } from "../../host/composition/session-files.js";
import { goalRecoveryOperations } from "../../host/composition/goal-recovery.js";
import { hostedMimiRuleScheduler } from "../../host/composition/mimi-rule-scheduler.js";
import type { MimiRuleReply } from "../../shared/mimi-rules.js";
import { hostRuntimePath } from "../../host/runtime-path.js";
import { HostedMimiProjection } from "../../host/composition/mimi-projection.js";
import type { MimiRecords } from "../../shared/mimi-records.js";
import { hostedMimiFollowUps } from "../../host/composition/mimi-follow-ups.js";
import { gitOperations } from "../../host/composition/git.js";
import { HostedMimiDispatch } from "../../host/composition/mimi-dispatch.js";
import { randomUUID } from "node:crypto";
import { labFiles } from "../../host/composition/optimization-lab.js";
import {hostedMarketplace} from "../../host/composition/marketplace.js";
import { hostedProfileLibrary } from "../../host/composition/profile-library.js";
import { configuredMcpProbe } from "../../host/composition/configured-mcp-probe.js";
import { HostedMimiTasks } from "../../host/composition/mimi-tasks.js";
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
import type { MimiReplyOperations } from "../../shared/mimi-gateway-turn.js";
import type { BusinessGrant, BusinessMethods } from "../../host/composition/business-calls.js";
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
import { dirname, join } from "node:path";
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
import { codeShellHome, registerOpenRouterCatalogCache, sessionsRoot } from "@cjhyy/code-shell-core";
import { startupOperations } from "../../host/composition/startup.js";
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

// Dream, scheduled Engines and Mimi auxiliary models price their calls in this process.
registerOpenRouterCatalogCache(join(codeShellHome(), "cache", "openrouter-models.json"));
// Cache the immutable app version so renderer catalog calls do not wait on Main.
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
const ruleScheduler = hostedMimiRuleScheduler({
  petDir: join(dirname(process.argv[2]), "pet"),
  rule: (call) => mimiBusiness("mimi/rules", call) as Promise<MimiRuleReply>,
  cron: (command) => mimiBusiness("automation/command", command),
  fire: (...args) => scheduler.fireRule(...args),
  report: (event, error) => console.warn("[Desktop Host]", event, error),
});
scheduler.rules = ruleScheduler.coordinator;
// Link-backed source definitions are validated against this process-local registry.
installDefaultLinkProviders();
const historyWorker = new ActivityHistoryWorker(
  {
    petDir: join(dirname(process.argv[2]), "pet"),
    sessionsDir: sessionsRoot(),
    roomsDir: join(process.argv[2], "..", "mobile-remote", "rooms"),
  },
  (options) =>
    new Worker(new URL("./activity-history-worker.mjs", import.meta.url), { workerData: options }),
);
const projection = new HostedMimiProjection({
  catalog: (options) => catalog.list(options),
  worker: () => worker,
  memory: async () => {
    const stored = await (await storage).request<MimiWorkSnapshot>("mimi/workMemory",{type:"snapshot"});
    if (!stored) throw Error("Mimi work memory unavailable");
    return stored;
  },
  external: (input) => historyWorker.mimiExternalActivity(input),
  publish: (update) => parent.postMessage({type:"mimi-projection",update}),
  report: (operation,error) => console.warn("[Desktop Host] Mimi projection",operation,error),
});
historyWorker.onExternalActivityChanged = () => projection.activityChanged();
const profileLibrary = hostedProfileLibrary(storage, historyWorker, (options) => catalog.list(options));
const activities = hostedActivityHistory(historyWorker);
const roomReads = ccRoomReads(historyWorker);
const runtimeCatalog = externalRuntimeCatalogOperations();
const mediaProtocol = hostedMediaProtocol();
const mimiTasks = new HostedMimiTasks(join(dirname(process.argv[2]), "pet"), {
  getSnapshot: () => projection.snapshot(), subscribe: (listener) => projection.state.subscribe(listener),
});
const segments = hostedMimiSegments(storage, historyWorker, (domain) =>
  parent.postMessage({ type: "mimi-records-changed", domain }),
);
const pluginCommandsChanged=(requestId:string)=>parent.postMessage({
  type:"settings-committed",requestId,effects:{panelApps:false,git:false,pet:false,externalVisibility:false,pluginCommands:true}
});
const skills=hostedSkills(new URL("./skill-worker.mjs",import.meta.url),pluginCommandsChanged);
const marketplace=hostedMarketplace(new URL("./marketplace-worker.mjs",import.meta.url),jobs=>parent.postMessage({type:"plugin-jobs",jobs}),pluginCommandsChanged);
async function mimiBusiness(
  method: "mimi/tasks" | "mimi/records" | "mimi/turnStorage" | "mimi/rules" | "automation/command",
  input: unknown,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const id = `mimi:${randomUUID()}`;
  const cancel = () => business.revoke(id);
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    return await business.run(id, method, input);
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
const followUps = hostedMimiFollowUps({
  petDir: join(dirname(process.argv[2]), "pet"),
  sessionsDir: sessionsRoot(),
  history: historyWorker,
  sessions: async () => (await projection.snapshot()).sessions,
  managerId: async () => (await readMimiList(storage, "metadata")).petSessionId,
  inbox: (grant) => ({
    getSnapshot: () => readMimiList(storage, "inboxSnapshot"),
    addIfAbsentDurably: (id) =>
      mimiBusiness("mimi/records", { action: "inboxClaim", args: [id] }, grant.signal) as
        Promise<ReturnType<MimiRecords["inboxClaim"]>>,
  }),
});
async function recordMimiReceipt(
  input: MimiReplyOperations["mimi/recordReceipt"]["input"],
  grant?: BusinessGrant,
) {
  const { petSessionId } = await readMimiList(storage, "metadata");
  grant?.assertCurrent();
  if (input.petSessionId !== petSessionId) throw Error("Mimi receipt Session changed");
  return historyWorker.mimiReply("mimi/recordReceipt", input, grant?.permit);
}
const mimiDispatch = new HostedMimiDispatch(
  storage,
  sessionsRoot(),
  (options) => catalog.list(options),
  mimiTasks,
  {
    getSnapshot: () => projection.snapshot(),
    resolveNavigation: async (request) => {
      await projection.start();
      return projection.state.resolveNavigation(request);
    },
    refreshCatalog: async (...args) => {
      await projection.start();
      return projection.state.refreshCatalog(...args);
    },
  },
  {
    render: (input) => historyWorker.mimiReply("mimi/renderReply", input),
    receipt: { record: recordMimiReceipt },
  },
  (cmd, signal) => mimiBusiness("mimi/tasks", cmd, signal),
  (cmd, signal) => mimiBusiness("mimi/records", cmd, signal),
  (cmd, signal) => mimiBusiness("mimi/turnStorage", cmd, signal),
);
let server: DesktopHostServer | undefined;
const approvals = new HostApprovalState((id, owner) => server?.allows(id, owner) ?? false);
// Native lifecycle retains the verified roots across Host restarts for its periodic sweep.
const reportedGitRoots = new Set<string>();
function reportGitRoot(root: string) {
  if (reportedGitRoots.has(root)) return;
  parent.postMessage({ type: "git-root-observed", root });
  reportedGitRoots.add(root);
}
const business = new HostBusinessCalls({
  ...startupOperations,
  "terminal/command": (call, grant) => {
    if (!server) throw Error("Terminal Host unavailable");
    return server.runWorkbenchTerminal(call, grant.signal);
  },
  ...approvals.native,
  "mimi/tasks": (command, grant) => mimiTasks.run(command, grant),
  ...segments,
  "mimi/proactiveState":async(call,grant)=>{
    const db=await storage;grant.assertCurrent();
    const reply=await db.request<import("../../shared/mimi-proactive-state.js").MimiProactiveReply>("mimi/proactiveState",{call,permit:grant.permit});
    if(!reply)throw Error("Mimi heartbeat state unavailable");
    return reply;
  },
  "mimi/conversationRoutes":async(call,grant)=>{
    const db=await storage;grant.assertCurrent();
    const reply=await db.request<import("../../shared/mimi-conversation-routes.js").MimiRouteReply>("mimi/conversationRoutes",{call,permit:grant.permit});
    if(!reply)throw Error("Mimi conversation routes unavailable");
    return reply;
  },
  "mimi/noticeLedger":async(call,grant)=>{
    const db=await storage; grant.assertCurrent();
    const row=await db.request<import("../../shared/mimi-notice-ledger.js").NoticeLedgerReply>("mimi/noticeLedger",{call,permit:grant.permit});
    if(!row)throw Error("Mimi notice ledger unavailable");
    return row;
  },
  "mimi/ruleScheduler": (command) => ruleScheduler.run(command),
  "mimi/rules": async (call, grant) => {
    const db = await storage;
    grant.assertCurrent();
    const reply = await db.request<import("../../shared/mimi-rules.js").MimiRuleReply>(
      "mimi/rules",
      { call, permit: grant.permit },
    );
    if (!reply) throw Error("Mimi rule storage unavailable");
    if (reply.ok && reply.changed) {
      ruleScheduler.changed();
      parent.postMessage({ type: "mimi-rules-changed" });
    }
    return reply;
  },
  "mimi/renderReply": (input, grant) =>
    historyWorker.mimiReply("mimi/renderReply", input, grant.permit),
  "mimi/recordReceipt": recordMimiReceipt,
  ...followUps.methods,
  ...projection.methods,
  "rooms/messages": (p) => historyWorker.roomHistory("rooms/messages", p),
  "rooms/historyPage": (p) => historyWorker.roomHistory("rooms/historyPage", p),
  ...gitOperations(),
  "files/turnHistory": (input, grant) => historyWorker.turnHistory(input, grant.permit),
  ...labFiles,
  ...skills.methods,
  ...marketplace.operations,
  ...profileLibrary.operations,
  ...configuredMcpProbe,
  ...wechatLoginOperations((event) => parent.postMessage({ type: "wechat-login-event", event })),
  ...mimiRecordsOperations(
    storage,
    (domain) => parent.postMessage({ type: "mimi-records-changed", domain }),
    (row) => projection.applyMemory(row),
  ),
  ...mediaProtocol.methods,
  ...activities.operations,
  ...attachmentOperations,
  "automation/command": (cmd, grant) => scheduler.command(cmd, grant.permit, grant.signal),
  ...runtimeCatalog,
  ...roomReads.native,
  ...catalogFiles,
  "transcripts/read": (input) => transcripts.read(input),
  "transcripts/write": (input, grant) => transcripts.commitWrite(input, grant.permit),
  "transcripts/delete": (input, grant) => transcripts.commitDelete(input, grant.permit),
  ...operations.methods,
  ...goalRecoveryOperations(storage),
  ...catalogEdits(storage),
  ...memoryOperations(storage),
  ...projectTrustOperations(storage),
  "transcripts/context": transcriptContextOperation(storage),
  ...sessionFileOperations(storage, (id) => index.changed(id)),
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
    for (const { envelope } of frames) {
      server?.notifySession(envelope.sessionId, "agent/streamEvent", { ...envelope });
      mimiDispatch.observe(envelope);
    }
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
  if (!ports.length && isDesktopHostControl(data) && data.type === "runtime-path") {
    hostRuntimePath.install(data.path);
    return;
  }
  if (isDesktopHostControl(data) && data.type === "im-gateway-port" && server && ports.length === 1 && !im) {
    im = bindImGateway(electronPrivatePort(ports[0]));
    return;
  }
  if (isDesktopHostControl(data) && data.type === "mimi-dispatch-port" && server && ports.length === 1) {
    mimiDispatch.bind(electronPrivatePort(ports[0]));
    return;
  }
  if (isDesktopHostControl(data) && data.type === "mimi-tasks-port" && server && ports.length === 1) {
    mimiTasks.bind(electronPrivatePort(ports[0]));
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
    remote = bindRemoteServices(electronPrivatePort(ports[0]), join(process.argv[2], ".."), {
      history: historyWorker,
      read: roomReads.read,
      models: () =>
        runtimeCatalog["external-runtime/models"]({ searchPath: process.env.PATH ?? "" }),
    });
    return;
  }
  if (
    isDesktopHostControl(data) &&
    data.type === "automation-port" &&
    server &&
    ports.length === 1
  ) {
    hostRuntimePath.whenReady(() => {
      if (stopping) ports[0].close();
      else scheduler.bind(electronPrivatePort(ports[0]), process.env.PATH ?? data.searchPath);
    });
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
      petProjection: projection,
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
    ruleScheduler.coordinator.stop();
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
          mimiDispatch.close(),
          followUps.close(),
          mimiTasks.close(),
          projection.close(),
          marketplace.close(),
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
        businessRead("mimi/projection", noBusinessArguments, () => projection.snapshot()),
        businessRead("mimi/longTasks", noBusinessArguments, () => mimiTasks.snapshot()),
        businessRead("sessions/history", noBusinessArguments, () => catalog.history(() => index.history())),
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
        ...profileLibrary.reads,
        ...marketplace.reads,
        ...scopedConfigurationReads((options) => catalog.list(options)),
        ...workspaceReads((options) => catalog.list(options), reportGitRoot),
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
