// Actual production external producer/Main projection + authenticated WS + Mobile hook.
// Synthetic stdio CLI only; this is not vendor CLI or physical-phone acceptance.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { SessionManager, sessionsRoot } from "@cjhyy/code-shell-core";
import { RemoteHostManager, TrustedDeviceStore } from "@cjhyy/code-shell-server/mobile-remote";
import { ExternalRuntimeService } from "../../packages/desktop/src/main/external-runtime-service.js";
import { SessionSnapshotStore } from "../../packages/desktop/src/main/SessionSnapshotStore.js";
import { publishOwnedExternalStream } from "../../packages/desktop/src/main/owned-external-stream.js";
import { MobileOutputRecovery } from "../../packages/desktop/src/main/mobile-remote/output-recovery.js";
import { MobileExternalRuntimeCommands } from "../../packages/desktop/src/main/mobile-remote/external-runtime-commands.js";
import {
  mobileOutputRecoveryAuthority,
  mobileSessionCommandAuthority,
} from "../../packages/desktop/src/main/mobile-remote/output-recovery-authority.js";
import { requireRendererProjectEntryPath } from "../../packages/desktop/src/main/renderer-project-path.js";
import {
  handleClientEvent,
  type OrchestratorCtx,
} from "../../packages/desktop/src/main/mobile-remote/handle-client-event.js";
import { getProjectStore } from "../../packages/desktop/src/main/project-store.js";
import {
  ensureMiniDom,
  flushMicrotasks,
  renderHook,
} from "../../packages/web/src/test-utils/renderHook.js";
import { MobileOutputClient } from "../../packages/web/src/hooks/mobileOutputClient.js";
import { useRemoteApp } from "../../packages/web/src/hooks/useRemoteApp.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const part = (index: number) =>
  `${index.toString().padStart(4, "0")}-汉🙂${"x".repeat(48 * 1024)}\n`;
export async function run(root: string, port: number) {
  assert(
    globalThis[Symbol.for("codeshell.external-output.fixture-guard")],
    "pre-Core guard required",
  );
  const cwd = join(root, "workspace");
  mkdirSync(cwd, { mode: 0o700 });
  const project = await getProjectStore().createFromPath(cwd);
  const owners = new Map<string, number>();
  let snapshots = new SessionSnapshotStore();
  const desktop: Array<{ id: number; event: unknown }> = [];
  const windows = [77, 88].map((id) => ({
    isDestroyed: () => false,
    webContents: { id, send: (_channel: string, event: unknown) => desktop.push({ id, event }) },
  }));
  const owner = windows[0]!;
  const devices = new TrustedDeviceStore(join(root, "trusted-devices.json"));
  const device = devices.addDevice({
    name: "Synthetic phone",
    secretHash: "synthetic-mobile-secret",
  });
  const viewerReplies: Array<{ viewer: string; event: unknown }> = [];
  const routed: string[] = [];
  let pages = 0,
    maxPageBytes = 0,
    nativeStarts = 0;
  let context: OrchestratorCtx;
  let pausedMirror = false;
  const remote = new RemoteHostManager({
    devices,
    outputJournal: true,
    async onClientEvent(raw) {
      const event = raw as Parameters<typeof handleClientEvent>[1];
      routed.push(
        event.type + (event.type === "session.select" && event.recoveryId ? ":recovery" : ""),
      );
      assert(
        remote.hasAuthenticatedViewer(event.viewerId!, event.deviceId!),
        "actual socket must match command viewer",
      );
      if (event.type === "session.outputJournal") pages++;
      if (
        [
          "session.select",
          "session.outputJournal",
          "session.recovery.cancel",
          "session.sync",
          "chat.send",
          "run.stop",
        ].includes(event.type)
      )
        await handleClientEvent(context, event);
    },
  });
  const stamps = new Map<string, string>();
  let authorityChanges = 0,
    authFailures = 0;
  const recovery = new MobileOutputRecovery({
    root: sessionsRoot,
    authority: async (id) => {
      const stamp = await mobileOutputRecoveryAuthority(id);
      if (stamps.has(id) && stamps.get(id) !== stamp) authorityChanges++;
      stamps.set(id, stamp);
      return stamp;
    },
    snapshot: (id, since) => snapshots.get(id, since),
    owner: (id) => owners.get(id),
    authenticated: (viewer, id) => {
      const ok = remote.hasAuthenticatedViewer(viewer, id);
      if (!ok) authFailures++;
      return ok;
    },
    reply: (viewer, event) => {
      viewerReplies.push({ viewer, event });
      if (event.type === "session.outputJournal")
        maxPageBytes = Math.max(maxPageBytes, Buffer.byteLength(JSON.stringify(event.page)));
      remote.sendToViewer(viewer, event);
    },
  });
  const service = new ExternalRuntimeService({
    featureFlags: () => ({ external_agent_runtime: true, external_host_tools: true }),
    projectTrust: () => "trusted",
    registerSession: (id, _cwd, ownerId) => {
      if (ownerId !== undefined) owners.set(id, ownerId);
    },
    releaseSession: (id) => {
      owners.delete(id);
    },
    resolveProjectBinding: () => ({ projectId: project.id, mainRootId: project.roots[0]!.id }),
    prepareCodexLaunch: async () => ({ command: join(root, "bin/codex"), env: process.env }),
    emit: (id, event) => {
      const entry = publishOwnedExternalStream(snapshots, windows, owners.get(id), id, event);
      if (entry && !pausedMirror) recovery.mirrorOwned(entry);
    },
  });
  const commands = new MobileExternalRuntimeCommands({
    authenticated: (viewer, id) => remote.hasAuthenticatedViewer(viewer, id),
    authority: mobileSessionCommandAuthority,
    owner: (id) => owners.get(id),
    service: () => service,
    isExternal: (id) =>
      service.hasSession(id) || new SessionManager().readSessionState(id)?.provider === "codex",
    exists: (id) => !!new SessionManager().readSessionState(id),
    attachmentPath: requireRendererProjectEntryPath,
  });
  remote.on("viewer-offline", ({ viewerId }: { viewerId: string }) => {
    recovery.revoke(viewerId);
    commands.revoke(viewerId, true);
  });
  const states = new Map();
  context = {
    outputRecovery: recovery,
    externalCommands: commands,
    remote,
    getBridge: () => ({
      getLastRunContext: () => ({}),
      getSnapshot: (id: string, since: number) => snapshots.get(id, since),
      injectWorkerMessage: () => {
        nativeStarts++;
        throw new Error("External session must never start native worker");
      },
    }),
    deviceState: (id: string) => {
      if (!states.has(id)) states.set(id, {});
      return states.get(id);
    },
    mobilePermissionModes: new Map(),
    mobileSessionCwds: new Map(),
    lookupDiskSessionCwd: async () => cwd,
    effectiveMobileRunCwd: () => cwd,
    resolveSessionWorkspaceRoot: async () => cwd,
    sendMobilePermissionMode() {},
    replayPendingMobileApprovals() {},
    broadcastMobileSession() {},
    uploads: {
      claim() {
        throw new Error("unexpected upload");
      },
      async release() {},
      async finalize() {},
    },
  } as unknown as OrchestratorCtx;
  const requests = () => {
    try {
      return readFileSync(process.env.CODESHELL_OUTPUT_REQUEST_LOG!, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return [];
      throw error;
    }
  };
  const turns = () => requests().filter((entry) => entry.event === "physical-turn").length;
  const output: Record<string, unknown> = {
    cases: [],
    actualPid: process.pid,
    ppid: process.ppid,
    homeHash: hash(process.env.HOME!),
    nodeVersion: process.versions.node,
    execPath: process.execPath,
    nodeBinaryHash: hash(readFileSync(process.execPath)),
    syntheticCliOnly: true,
    actualMobileHook: true,
  };
  const cases = output.cases as string[];
  let cleanupHook = async () => {};
  try {
    await remote.start({ host: "127.0.0.1", port });
    const origin = `http://127.0.0.1:${port}`;
    process.env.CODESHELL_OUTPUT_PARTS = "192";
    await service.start({
      sessionId: "external-mobile",
      kind: "codex",
      cwd,
      model: "synthetic",
      ownerWindow: owner as never,
    });
    const first = await service.send(
      "external-mobile",
      { text: "first", displayText: "first", clientMessageId: "desktop-first" },
      77,
    );
    assert.equal(first.reason, "completed");
    const expected = Array.from({ length: 192 }, (_, index) => part(index)).join("");
    assert(Buffer.byteLength(expected) > 8 * 1024 * 1024);
    assert(snapshots.get("external-mobile").events[0]!.seq > 1, "actual snapshot eviction");
    await mobileOutputRecoveryAuthority("external-mobile");
    const NativeEvent = globalThis.Event;
    ensureMiniDom();
    Reflect.deleteProperty(globalThis, "navigator");
    Object.defineProperty(globalThis, "Event", { configurable: true, value: NativeEvent });
    const storage = new Map([
      ["cs.deviceId", device.id],
      ["cs.deviceSecret", "synthetic-mobile-secret"],
      ["cs.deviceName", "Synthetic phone"],
    ]);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
    const NativeWebSocket = globalThis.WebSocket;
    class FixtureWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        assert.equal(
          String(url),
          origin.replace(/^http/, "ws") + "/ws",
          "Non-fixture WebSocket refused",
        );
        super(url, protocols);
      }
    }
    assert.throws(() => new FixtureWebSocket("wss://example.invalid/ws"), /Non-fixture/);
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FixtureWebSocket });
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { origin, pathname: "/mobile", search: "" },
    });
    Object.defineProperty(window, "history", { configurable: true, value: { replaceState() {} } });
    // MiniDOM supplies no browser fetch; use the actual pre-Core guarded Node transport.
    Object.defineProperty(window, "fetch", { configurable: true, value: globalThis.fetch });
    const hook = await renderHook(() => useRemoteApp());
    cleanupHook = () => hook.unmount();
    const text = () =>
      hook.result.current.chat.items
        .filter((item) => item.kind === "assistant")
        .map((item) => item.text)
        .join("");
    let phase = "authentication";
    const until = async (condition: () => boolean) => {
      for (let count = 0; count < 700; count++) {
        await act(async () => {
          await sleep(10);
          await flushMicrotasks();
        });
        if (condition()) return;
      }
      throw new Error(
        "Mobile external fixture did not settle: " +
          JSON.stringify({
            phase,
            status: hook.result.current.status,
            routed: routed.slice(-12),
            notice: hook.result.current.notice,
            pages,
            run: hook.result.current.chat.run,
            bytes: Buffer.byteLength(text()),
            authorityChanges,
            authFailures,
            replies: viewerReplies
              .slice(-5)
              .map(({ event }) => ({
                type: (event as any).type,
                seq: (event as any).seq,
                nextSeq: (event as any).nextSeq,
                ok: (event as any).ok,
              })),
            mirrorCounts: viewerReplies.reduce((counts: Record<string, number>, row) => {
              const key = (row.event as any).type;
              counts[key] = (counts[key] ?? 0) + 1;
              return counts;
            }, {}),
          }),
      );
    };
    await until(() => remote.onlineDeviceIds().includes(device.id));
    phase = "initial selection";
    await act(async () => {
      hook.result.current.selectSession("external-mobile");
      await flushMicrotasks();
    });
    await until(() => text() === expected && hook.result.current.chat.run === "completed");
    assert.equal(turns(), 1);
    assert.equal(nativeStarts, 0);
    assert(pages > 8);
    cases.push("initial authenticated >8MiB evicted journal recovery without second execution");
    const beforeLivePages = pages;
    // Desktop initiates a genuine second turn, phone receives the same committed input/output.
    phase = "live desktop second";
    const second = service.send(
      "external-mobile",
      { text: "second", displayText: "second", clientMessageId: "desktop-second" },
      77,
    );
    await until(
      () => text() === expected + expected && hook.result.current.chat.run === "completed",
    );
    assert.equal((await second).reason, "completed");
    assert.equal(turns(), 2);
    assert(pages > beforeLivePages, "coalesced live gap must join journal");
    assert.equal(
      hook.result.current.chat.items.filter(
        (item) => item.kind === "user" && item.clientMessageId === "desktop-second",
      ).length,
      1,
    );
    cases.push("owned live stream/cursor gap joins the same durable run once");
    let mobileAccepted = false;
    await act(async () => {
      mobileAccepted = await hook.result.current.sendChat({
        text: "mobile third",
        attachments: [],
      });
    });
    assert(
      mobileAccepted,
      JSON.stringify({
        notice: hook.result.current.notice,
        replies: viewerReplies
          .slice(-3)
          .map(({ event }) => ({ type: (event as any).type, message: (event as any).message })),
      }),
    );
    await until(
      () => text() === expected.repeat(3) && hook.result.current.chat.run === "completed",
    );
    assert.equal(turns(), 3);
    assert.equal(nativeStarts, 0);
    cases.push("actual Mobile send commits to same existing external producer exactly once");
    const transcript = new SessionManager().resume("external-mobile").transcript.getEvents();
    const mobileUser = transcript.findLast(
      (entry) => entry.type === "message" && entry.data.role === "user",
    )!;
    const retryId = mobileUser.data.clientMessageId as string;
    assert(retryId);
    const viewer = viewerReplies.find(
      (row) => (row.event as { type: string }).type === "session.recovery.ready",
    )!.viewer;
    await handleClientEvent(context, {
      type: "chat.send",
      viewerId: viewer,
      deviceId: device.id,
      sessionId: "external-mobile",
      text: "mobile third",
      clientMessageId: retryId,
    });
    await handleClientEvent(context, {
      type: "chat.send",
      viewerId: viewer,
      deviceId: device.id,
      sessionId: "external-mobile",
      text: "conflicting payload",
      clientMessageId: retryId,
    });
    assert.equal(turns(), 3);
    assert.equal(
      new SessionManager().readSessionState("external-mobile")!.outputRecoveryIncomplete,
      undefined,
    );
    cases.push(
      "same/conflicting duplicate ID rejects zero execution without poisoning healthy journal",
    );
    const oldEpoch = snapshots.epoch,
      beforeReconnectPages = pages;
    await act(async () => {
      await remote.stop();
      await sleep(20);
    });
    snapshots = new SessionSnapshotStore();
    await remote.start({ host: "127.0.0.1", port });
    await until(
      () =>
        pages > beforeReconnectPages + 8 &&
        hook.result.current.chat.run === "completed" &&
        !hook.result.current.loading.sessionHistory,
    );
    assert.notEqual(snapshots.epoch, oldEpoch);
    assert.equal(text(), expected.repeat(3));
    assert.equal(turns(), 3);
    cases.push("authenticated reconnect joins cold Main RAM epoch without another CLI request");
    phase = "attachments only";
    let imageAccepted = false;
    await act(async () => {
      imageAccepted = await hook.result.current.sendChat({
        text: "",
        attachments: [
          {
            clientId: "phone-image",
            file: new File(
              [
                Buffer.from(
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                  "base64",
                ),
              ],
              "phone.png",
              { type: "image/png" },
            ),
          },
        ],
      });
    });
    assert(imageAccepted);
    await until(
      () => text() === expected.repeat(3) + part(0) && hook.result.current.chat.run === "completed",
    );
    assert.equal(turns(), 4);
    const imageUser = hook.result.current.chat.items.findLast((item) => item.kind === "user");
    assert(imageUser?.kind === "user");
    assert.equal(imageUser.attachments?.length, 1);
    assert(!JSON.stringify(imageUser).includes("base64"));
    assert.equal(nativeStarts, 0);
    cases.push(
      "actual attachment-only Mobile hook input stages trusted image and canonical recovery projection once",
    );
    const beforeColdRead = turns();
    const coldChild = spawn(
      process.execPath,
      [process.env.CODESHELL_OUTPUT_COLD_ENTRY!, "cold", "external-mobile"],
      { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let coldOut = "",
      coldErr = "";
    coldChild.stdout.on("data", (chunk) => {
      coldOut += chunk;
      assert(coldOut.length < 64 * 1024);
    });
    coldChild.stderr.on("data", (chunk) => {
      coldErr += chunk;
      assert(coldErr.length < 64 * 1024);
    });
    const coldCode = await new Promise((done, reject) => {
      coldChild.once("error", reject);
      coldChild.once("close", done);
    });
    assert.equal(coldCode, 0, coldErr);
    const coldReceipt = JSON.parse(coldOut.trim());
    assert.notEqual(coldReceipt.pid, process.pid);
    assert.equal(coldReceipt.ppid, process.pid);
    assert.equal(coldReceipt.textHash, hash(text()));
    assert.equal(coldReceipt.run, "completed");
    assert.equal(coldReceipt.nodeVersion, process.versions.node);
    assert.equal(coldReceipt.homeHash, hash(process.env.HOME!));
    assert.equal(turns(), beforeColdRead);
    output.coldMain = coldReceipt;
    cases.push(
      "second actual Node Main with empty RAM recovers authenticated pages without CLI construction",
    );
    // A sibling authenticated tab selects a different Session: no external stream is broadcast to it.
    const other = new FixtureWebSocket(origin.replace(/^http/, "ws") + "/ws");
    const otherEvents: Array<Record<string, unknown>> = [];
    other.addEventListener("message", (event) => otherEvents.push(JSON.parse(String(event.data))));
    await new Promise<void>((done) => other.addEventListener("open", () => done(), { once: true }));
    other.send(
      JSON.stringify({
        type: "auth.device",
        deviceId: device.id,
        secretHash: "synthetic-mobile-secret",
      }),
    );
    await until(() => otherEvents.some((event) => event.type === "auth.ok"));
    other.send(
      JSON.stringify({
        type: "session.select",
        sessionId: "missing-other",
        recoveryId: "other-tab",
      }),
    );
    await sleep(30);
    // Stop the existing producer; read recovery must still work but Mobile must not allocate a replacement.
    await service.stop("external-mobile", 77);
    const beforeColdSend = turns();
    const currentViewer =
      viewerReplies
        .filter(
          (row) =>
            (row.event as { type: string; ok?: boolean }).type === "session.recovery.ready" &&
            (row.event as { ok?: boolean }).ok === true,
        )
        .at(-1)?.viewer ?? viewer;
    await handleClientEvent(context, {
      type: "chat.send",
      viewerId: currentViewer,
      deviceId: device.id,
      sessionId: "external-mobile",
      text: "cold must reject",
      clientMessageId: "cold-denied",
    });
    assert.equal(turns(), beforeColdSend);
    assert.equal(nativeStarts, 0);
    cases.push("cold no-live-instance send rejected with no native fallback");
    // A separate actual held protocol turn tests Mobile cancel without relying
    // on provider completion timing or issuing a second model request.
    process.env.CODESHELL_OUTPUT_PARTS = "1";
    process.env.CODESHELL_OUTPUT_HOLD = "1";
    await service.start({
      sessionId: "external-held",
      kind: "codex",
      cwd,
      model: "synthetic",
      ownerWindow: owner as never,
    });
    const held = service.send(
      "external-held",
      { text: "held", displayText: "held", clientMessageId: "held-input" },
      77,
    );
    phase = "select held run";
    await act(async () => {
      hook.result.current.selectSession("external-held");
    });
    await until(() => hook.result.current.chat.run === "running" && text() === part(0));
    const beforeCancel = turns();
    await act(async () => {
      hook.result.current.stopRun();
    });
    await until(
      () =>
        hook.result.current.chat.run === "idle" && !snapshots.get("external-held").topLevelRunning,
    );
    assert.equal((await held).reason, "aborted_streaming");
    assert.equal(turns(), beforeCancel);
    assert.equal(nativeStarts, 0);
    cases.push(
      "actual Mobile cancel targets only the captured existing external run with one aborted journal terminal",
    );
    await service.stop("external-held", 77);
    other.close();
    assert(
      !otherEvents.some(
        (event) => event.type === "session.stream" && event.sessionId === "external-mobile",
      ),
    );
    assert(!desktop.some((event) => event.id === 88));
    assert(maxPageBytes <= 1024 * 1024 + 16 * 1024);
    await getProjectStore().remove(project.id);
    await assert.rejects(mobileOutputRecoveryAuthority("external-mobile"));
    devices.revoke(device.id);
    remote.revokeDevice(device.id);
    await until(() => !remote.onlineDeviceIds().length);
    cases.push("project/device revocation and non-owner window isolation");
    Object.assign(output, {
      pages,
      maxPageBytes,
      physicalTurns: turns(),
      nativeStarts,
      recoveredBytes: Buffer.byteLength(expected),
      journalBytes: statSync(join(sessionsRoot(), "external-mobile", "output-journal.jsonl")).size,
      textHash: hash(text()),
      desktopOwnerOnly: true,
    });
    console.log(JSON.stringify(output));
  } finally {
    await cleanupHook();
    await service.stopAll();
    await remote.stop();
  }
}

/** Second actual Node Main: empty RAM, real paired WS, production page authority, no runtime construction. */
export async function cold(root: string, port: number, sessionId: string) {
  const snapshots = new SessionSnapshotStore();
  const devices = new TrustedDeviceStore(join(root, "trusted-devices.json"));
  const device = devices.listDevices()[0]!;
  let recovery!: MobileOutputRecovery;
  let pages = 0;
  const remote = new RemoteHostManager({
    devices,
    outputJournal: true,
    onClientEvent: async (event) => {
      assert(remote.hasAuthenticatedViewer(event.viewerId!, event.deviceId!));
      if (event.type === "session.outputJournal") pages++;
      assert(
        ["session.select", "session.outputJournal", "session.recovery.cancel"].includes(event.type),
      );
      await recovery.handle(event);
    },
  });
  recovery = new MobileOutputRecovery({
    root: sessionsRoot,
    authority: mobileOutputRecoveryAuthority,
    snapshot: (id, since) => snapshots.get(id, since),
    authenticated: (viewer, id) => remote.hasAuthenticatedViewer(viewer, id),
    reply: (viewer, event) => remote.sendToViewer(viewer, event),
  });
  await remote.start({ host: "127.0.0.1", port });
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  let result: any,
    failed = false;
  const client = new MobileOutputClient({
    current: () => ({ sessionId, revision: 1 }),
    send: (event) => {
      if (socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(event));
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
  socket.addEventListener("message", (message) => {
    const event = JSON.parse(String(message.data));
    client.observe(event);
    if (event.type === "auth.ok") client.begin(sessionId);
  });
  try {
    await new Promise<void>((done, reject) => {
      socket.addEventListener("open", () => done(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    socket.send(
      JSON.stringify({
        type: "auth.device",
        deviceId: device.id,
        secretHash: "synthetic-mobile-secret",
      }),
    );
    for (let i = 0; i < 1500 && !result && !failed; i++) await sleep(10);
    assert(result && !failed, "bounded cold authenticated recovery did not join");
    const text = result.chat.items
      .filter((item: any) => item.kind === "assistant")
      .map((item: any) => item.text)
      .join("");
    return {
      pid: process.pid,
      ppid: process.ppid,
      nodeVersion: process.versions.node,
      execPath: process.execPath,
      nodeBinaryHash: hash(readFileSync(process.execPath)),
      homeHash: hash(process.env.HOME!),
      pages,
      textHash: hash(text),
      run: result.chat.run,
      epoch: snapshots.epoch,
      emptyInitialRam: true,
      runtimeConstructed: false,
    };
  } finally {
    client.cancel(false);
    socket.close();
    await remote.stop();
  }
}
