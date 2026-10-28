// Real authenticated WS -> Main dispatcher -> canonical runtime service -> synthetic CLI.
// Electron windows are owner adapters; no runtime, approval or transport result is stubbed.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { SessionManager, sessionsRoot } from "@cjhyy/code-shell-core";
import { SessionOutputCoverageStore } from "@cjhyy/code-shell-core/internal";
import {
  RemoteHostManager,
  TrustedDeviceStore,
  MobileUploadService,
} from "@cjhyy/code-shell-server/mobile-remote";
import { ExternalRuntimeService } from "../../packages/desktop/src/main/external-runtime-service.js";
import { ExternalRuntimeModelService } from "../../packages/desktop/src/main/external-runtime-model-service.js";
import { ExternalRuntimeApprovals } from "../../packages/desktop/src/main/external-runtime-approvals.js";
import { SessionSnapshotStore } from "../../packages/desktop/src/main/SessionSnapshotStore.js";
import { publishOwnedExternalStream } from "../../packages/desktop/src/main/owned-external-stream.js";
import {
  MobileExternalRuntimeCommands,
  isPersistedExternalRuntime,
  persistedExternalRuntimeModelKey,
} from "../../packages/desktop/src/main/mobile-remote/external-runtime-commands.js";
import {
  handleClientEvent,
  type OrchestratorCtx,
} from "../../packages/desktop/src/main/mobile-remote/handle-client-event.js";
import { startMobileExternalRuntime } from "../../packages/desktop/src/main/mobile-remote/start-external-runtime.js";
import {
  mobileNewSessionAuthority,
  mobileSessionCommandAuthority,
  mobileOutputRecoveryAuthority,
} from "../../packages/desktop/src/main/mobile-remote/output-recovery-authority.js";
import { MobileOutputRecovery } from "../../packages/desktop/src/main/mobile-remote/output-recovery.js";
import { requireRendererProjectEntryPath } from "../../packages/desktop/src/main/renderer-project-path.js";
import { getProjectStore } from "../../packages/desktop/src/main/project-store.js";
import { MobileOutputClient } from "../../packages/web/src/hooks/mobileOutputClient.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const NativeWebSocket = globalThis.WebSocket;
export async function runRuntimeLifecycle(root: string) {
  assert(globalThis[Symbol.for("codeshell.external-output.fixture-guard")]);
  const cwd = join(root, "lifecycle-workspace");
  mkdirSync(cwd);
  const project = await getProjectStore().createFromPath(cwd);
  const manager = new SessionManager();
  const owners = new Map<string, number>();
  const windows = [{ isDestroyed: () => false, webContents: { id: 177, send() {} } }];
  const devices = new TrustedDeviceStore(join(root, "lifecycle-devices.json"));
  const device = devices.addDevice({
    name: "Lifecycle phone",
    secretHash: "synthetic-lifecycle-secret",
  });
  const snapshots = new SessionSnapshotStore({
    coverage: new SessionOutputCoverageStore(sessionsRoot),
  });
  const uploads = new MobileUploadService({
    rootDir: join(root, "lifecycle-uploads"),
    cleanupIntervalMs: 0,
  });
  const cases: string[] = [];
  const routed: string[] = [];
  let context!: OrchestratorCtx;
  let commands!: MobileExternalRuntimeCommands;
  const remote = new RemoteHostManager({
    devices,
    uploads,
    outputJournal: true,
    async onClientEvent(event) {
      assert(remote.hasAuthenticatedViewer(event.viewerId!, event.deviceId!));
      routed.push(event.type);
      await handleClientEvent(context, event);
    },
  });
  const approvals = new ExternalRuntimeApprovals({
    windows: () => windows as never,
    ownerWebContentsId: (id) => owners.get(id),
    onPendingChange: (event) => {
      void commands.mirrorApproval(event);
    },
  });
  const recovery = new MobileOutputRecovery({
    root: sessionsRoot,
    authority: mobileOutputRecoveryAuthority,
    journalRequired: (id) => isPersistedExternalRuntime(manager.readSessionState(id)),
    snapshot: (id, since) => snapshots.get(id, since),
    owner: (id) => owners.get(id),
    authenticated: (viewer, id) => remote.hasAuthenticatedViewer(viewer, id),
    reply: (viewer, event) => remote.sendToViewer(viewer, event),
  });
  const service = new ExternalRuntimeService({
    featureFlags: () => ({ external_agent_runtime: true, external_host_tools: true }),
    projectTrust: () => "trusted",
    registerSession: (id, _cwd, owner) => {
      if (owner !== undefined) owners.set(id, owner);
    },
    releaseSession: (id) => {
      owners.delete(id);
    },
    resolveProjectBinding: () => ({ projectId: project.id, mainRootId: project.roots[0]!.id }),
    prepareCodexLaunch: async () => ({ command: join(root, "bin/codex"), env: process.env }),
    requestApproval: (id, request) => approvals.request(id, request),
    cancelApprovals: (id) => approvals.cancelSession(id),
    emit: (id, event) => {
      const entry = publishOwnedExternalStream(snapshots, windows, owners.get(id), id, event);
      if (entry) recovery.mirrorOwned(entry);
    },
  });
  let nativeStarts = 0;
  const bridge = {
    panelOwnerWebContentsId: (id: string) => owners.get(id),
    isSessionRunning: (id: string) => service.get(id) && !!service.captureActiveRun(id, 177),
    getLastRunContext: () => ({}),
    getSnapshot: (id: string, since: number) => snapshots.get(id, since),
    injectWorkerMessage: () => {
      nativeStarts++;
      throw new Error("External input reached native worker");
    },
  };
  commands = new MobileExternalRuntimeCommands({
    authenticated: (viewer, id) => remote.hasAuthenticatedViewer(viewer, id),
    authority: mobileSessionCommandAuthority,
    owner: (id) => owners.get(id),
    service: () => service,
    isExternal: (id) =>
      service.hasSession(id) || isPersistedExternalRuntime(manager.readSessionState(id)),
    exists: (id) => !!manager.readSessionState(id),
    modelKey: (id) => persistedExternalRuntimeModelKey(manager.readSessionState(id)),
    attachmentPath: requireRendererProjectEntryPath,
    startRuntime: (request) =>
      startMobileExternalRuntime(
        { service: () => service, bridge: () => bridge as never, windows: () => windows as never },
        request,
      ),
    approvals: () => approvals,
    approvalEvent: (viewer, event) => {
      if (event.type === "requested")
        remote.sendRawToViewer(
          viewer,
          JSON.stringify({
            jsonrpc: "2.0",
            method: "agent/approvalRequest",
            params: {
              sessionId: event.sessionId,
              requestId: event.requestId,
              request: event.request,
            },
          }),
        );
      else
        remote.sendToViewer(viewer, {
          type: "approval.resolved",
          approvalId: event.requestId,
          sessionId: event.sessionId,
          approved: event.approved,
          answer: event.answer,
        });
    },
  });
  remote.on("viewer-offline", ({ viewerId }) => {
    recovery.revoke(viewerId);
    commands.revoke(viewerId, true);
  });
  const models = new ExternalRuntimeModelService({ isEnabled: () => true });
  const states = new Map();
  context = {
    remote,
    uploads,
    outputRecovery: recovery,
    externalCommands: commands,
    externalRuntimeModels: () => models.list(),
    newSessionAuthority: mobileNewSessionAuthority,
    getBridge: () => bridge,
    deviceState: (id: string) => {
      if (!states.has(id)) states.set(id, {});
      return states.get(id);
    },
    mobileSessionCwds: new Map(),
    mobilePermissionModes: new Map(),
    effectiveMobileRunCwd: (state: any) => state.selectedCwd ?? cwd,
    resolveMobileProjectRoot: (id: string, rootId?: string) => {
      const resolved = getProjectStore().resolveProjectRootByIdSync(id, rootId);
      return { projectId: resolved.project.id, rootId: resolved.mainRoot.id, cwd: resolved.cwd };
    },
    validateMobileSessionCwd: async (path: string) => path === cwd,
    resolveSessionWorkspaceRoot: async (_id: string, path: string) => path,
    lookupDiskSessionCwd: async (id: string) => manager.readSessionState(id)?.cwd,
    sendMobilePermissionMode: (id: string, sessionId: string) =>
      remote.sendToDevice(id, { type: "permission.mode", sessionId, mode: "default" }),
    replayPendingMobileApprovals() {},
    broadcastMobileSession() {},
  } as unknown as OrchestratorCtx;
  const requests = () =>
    readFileSync(process.env.CODESHELL_OUTPUT_REQUEST_LOG!, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const turns = () => requests().filter((item) => item.event === "physical-turn").length;
  let socket!: WebSocket;
  let outputClient: MobileOutputClient | undefined;
  let authenticated: any;
  const events: any[] = [];
  let sequence = 0;
  let phase = "connect";
  const until = async (predicate: () => boolean) => {
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      if (predicate()) return;
      await sleep(10);
    }
    throw new Error(
      "Lifecycle deadline: " +
        JSON.stringify({
          phase,
          routed: routed.slice(-8),
          events: events.slice(-5).map((event) => ({
            type: event.type ?? event.method,
            message: event.message,
            ok: event.ok,
          })),
        }),
    );
  };
  const send = (event: unknown) => socket.send(JSON.stringify(event));
  const ask = async (event: unknown, predicate: (event: any) => boolean) => {
    const offset = events.length;
    send(event);
    await until(() => events.slice(offset).some(predicate));
    return events.slice(offset).find(predicate);
  };
  const connect = async (port: number) => {
    socket = new NativeWebSocket(`ws://127.0.0.1:${port}/ws`);
    socket.addEventListener("message", (message) => {
      const event = JSON.parse(String(message.data));
      events.push(event);
      outputClient?.observe(event);
    });
    await once(socket, "open");
    const auth = await ask(
      { type: "auth.device", deviceId: device.id, secretHash: "synthetic-lifecycle-secret" },
      (event) => event.type === "auth.ok",
    );
    assert.equal(auth.device.id, device.id);
    authenticated = auth;
  };
  const select = async (sessionId: string) => {
    outputClient?.cancel(false);
    outputClient = undefined;
    await ask(
      { type: "session.select", sessionId },
      (event) => event.type === "permission.mode" && event.sessionId === sessionId,
    );
  };
  const recover = async (sessionId: string) => {
    outputClient?.cancel(false);
    let result: any;
    let failed = false;
    const revision = ++sequence;
    outputClient = new MobileOutputClient({
      current: () => ({ sessionId, revision }),
      send: (event) => {
        send(event);
        return true;
      },
      commit: (_id, recovered) => {
        result = recovered;
      },
      failed: () => {
        failed = true;
      },
      legacy: () => {
        failed = true;
      },
    });
    outputClient.observe(authenticated);
    outputClient.begin(sessionId);
    await until(() => !!result || failed);
    assert(!failed, "Canonical external output must recover");
    return result;
  };
  const idle = (id: string) => !service.captureActiveRun(id, 177);
  const submit = async (id: string, text: string, modelKey?: string) => {
    const clientMessageId = `lifecycle-message-${++sequence}`;
    const result = await ask(
      {
        type: "chat.send",
        sessionId: id,
        text,
        clientMessageId,
        ...(modelKey ? { modelKey } : {}),
      },
      (event) =>
        (event.type === "chat.accepted" && event.clientMessageId === clientMessageId) ||
        (event.type === "error" && event.clientMessageId === clientMessageId),
    );
    assert.equal(result.type, "chat.accepted", JSON.stringify(result));
    return clientMessageId;
  };
  try {
    process.env.CODESHELL_OUTPUT_PARTS = "1";
    const started = await remote.start({ host: "127.0.0.1", port: 0 });
    await connect(started.port);
    phase = "runtime catalog";
    const catalog = await ask(
      { type: "runtime.models" },
      (event) => event.type === "runtime.models.ok",
    );
    assert(catalog.models.some((model: any) => model.key === "codex/synthetic"));
    assert(catalog.models.some((model: any) => model.key === "claude-code/sonnet"));
    assert(requests().some((entry) => entry.event === "model-catalog"));
    cases.push(
      "actual synthetic Codex model/list reaches Mobile runtime.models alongside Claude choices",
    );
    for (let index = 0; index < 103; index++) {
      const id = `lifecycle-saved-${index}`;
      const kind = index % 2 ? "codex" : "claude-code";
      manager.create(
        cwd,
        `${kind}/${kind === "codex" ? "synthetic" : "sonnet"}`,
        kind,
        id,
        null,
        "desktop",
      );
    }
    phase = "cold session list pagination";
    const first = await ask(
      { type: "session.list", requestId: "lifecycle-page-1", cwds: [cwd] },
      (event) => event.type === "session.list.ok" && event.requestId === "lifecycle-page-1",
    );
    assert.equal(first.sessions.length, 100);
    assert(first.nextCursor);
    const second = await ask(
      {
        type: "session.list",
        requestId: "lifecycle-page-2",
        cwds: [cwd],
        cursor: first.nextCursor,
      },
      (event) => event.type === "session.list.ok" && event.requestId === "lifecycle-page-2",
    );
    assert.equal(second.sessions.length, 3);
    assert.equal(
      new Set([...first.sessions, ...second.sessions].map((entry) => entry.id)).size,
      103,
    );
    assert(
      [...first.sessions, ...second.sessions].every((entry) =>
        ["codex", "claude-code"].includes(entry.provider),
      ),
    );
    cases.push(
      "103 cold canonical external sessions paginate over authenticated WS with provider metadata",
    );
    for (const kind of ["codex", "claude-code"] as const) {
      const modelKey = `${kind}/${kind === "codex" ? "synthetic" : "sonnet"}`;
      process.env.CODESHELL_OUTPUT_PARTS = "25";
      phase = `${kind} create and selected model send`;
      const clientRequestId = `lifecycle-create-${kind}`;
      const created = await ask(
        {
          type: "session.create",
          projectId: project.id,
          rootId: project.roots[0]!.id,
          clientRequestId,
        },
        (event) => event.type === "chat.accepted" && event.clientRequestId === clientRequestId,
      );
      const id = created.sessionId;
      const before = turns();
      await submit(id, "lifecycle initial", modelKey);
      await until(() => idle(id));
      process.env.CODESHELL_OUTPUT_PARTS = "1";
      assert.equal(turns(), before + 1);
      assert(
        requests().some(
          (entry) =>
            entry.kind === kind &&
            entry.model === modelKey.split("/")[1] &&
            entry.resumed === false,
        ),
      );
      assert.equal(manager.readSessionState(id)?.provider, kind);
      assert.equal(manager.readSessionState(id)?.model, modelKey);
      const pagesBefore = routed.filter((type) => type === "session.outputJournal").length;
      const initial = await recover(id);
      assert(
        routed.filter((type) => type === "session.outputJournal").length - pagesBefore >= 2,
        "Both providers must recover across real journal pages",
      );
      assert.equal(initial.chat.run, "completed");
      assert(
        initial.chat.items.some(
          (item: any) => item.kind === "assistant" && item.text.includes("0000-汉🙂"),
        ),
      );
      await service.stop(id, 177);
      assert.equal(service.get(id), undefined);
      phase = `${kind} saved session resume`;
      await select(id);
      await submit(id, "lifecycle saved continuation");
      await until(() => idle(id));
      assert.equal(turns(), before + 2);
      assert(
        requests().some(
          (entry) =>
            entry.kind === kind && entry.model === modelKey.split("/")[1] && entry.resumed === true,
        ),
      );
      const restored = await recover(id);
      assert.equal(restored.chat.items.filter((item: any) => item.kind === "user").length, 2);
      cases.push(
        `${kind}: mobile-selected model creates canonical task; stopped runtime resumes saved history and accepts one turn`,
      );
      phase = `${kind} approval and reconnect replay`;
      await select(id);
      const approvalOffset = events.length;
      await submit(id, "lifecycle-approval");
      await until(() =>
        events
          .slice(approvalOffset)
          .some(
            (event) => event.method === "agent/approvalRequest" && event.params.sessionId === id,
          ),
      );
      const pending = events
        .slice(approvalOffset)
        .find((event) => event.method === "agent/approvalRequest").params;
      socket.close();
      await once(socket, "close");
      await connect(started.port);
      const replayOffset = events.length;
      await select(id);
      await until(() =>
        events
          .slice(replayOffset)
          .some(
            (event) =>
              event.method === "agent/approvalRequest" &&
              event.params.requestId === pending.requestId,
          ),
      );
      const stale = await ask(
        {
          type: "approval.respond",
          sessionId: id,
          approvalId: "stale-request",
          decision: "approve",
        },
        (event) => event.type === "error" && event.approvalId === "stale-request",
      );
      assert(stale.message);
      assert(approvals.hasPendingSession(id));
      send({
        type: "approval.respond",
        sessionId: id,
        approvalId: pending.requestId,
        decision: "approve",
        answer: "accept",
      });
      await until(() => idle(id));
      assert(!approvals.hasPendingSession(id));
      const decision = requests().find(
        (entry) => entry.kind === kind && entry.event === "approval-answer",
      );
      assert(decision);
      if (kind === "codex")
        assert.deepEqual(decision.answers, { fixture: { answers: ["accept"] } });
      else assert.equal(decision.decision, "allow");
      const approved = await recover(id);
      assert.equal(approved.chat.run, "completed");
      cases.push(
        `${kind}: native CLI approval crosses Main and WS, survives reconnect, and returns to physical CLI`,
      );
      phase = `${kind} stop held CLI`;
      await select(id);
      const heldBefore = requests().filter(
        (entry) => entry.kind === kind && entry.event === "turn-held",
      ).length;
      await submit(id, "lifecycle-hold");
      await until(
        () =>
          requests().filter((entry) => entry.kind === kind && entry.event === "turn-held")
            .length ===
          heldBefore + 1,
      );
      assert(service.captureActiveRun(id, 177));
      send({ type: "run.stop", sessionId: id });
      await until(() => idle(id));
      const stopped = await recover(id);
      assert.notEqual(stopped.chat.run, "completed");
      assert.equal(turns(), before + 4);
      if (kind === "codex")
        assert(
          requests().some((entry) => entry.kind === kind && entry.event === "turn-interrupted"),
        );
      cases.push(
        `${kind}: Mobile Stop interrupts the owned synthetic process/turn without native fallback`,
      );
      await service.stop(id, 177);
    }
    assert.equal(nativeStarts, 0);
    console.log(
      JSON.stringify({
        mobileRuntimeLifecycle: true,
        cases,
        nativeStarts,
        actualNode: process.versions.node,
        syntheticOnly: true,
      }),
    );
  } finally {
    outputClient?.cancel(false);
    socket?.close();
    await service.stopAll();
    await remote.stop();
    await getProjectStore().remove(project.id);
  }
}
