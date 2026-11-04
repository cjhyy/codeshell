import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RoomBusyError,
  RoomManager,
  type MobileServerEvent,
  type MobileTurnQueueTarget,
  type ResidentAgentEvent,
  type RoomAgent,
} from "@cjhyy/code-shell-server/mobile-remote";
import type { WorkerFrameMeta } from "@cjhyy/code-shell-server/worker";
import type { AgentBridge } from "../agent-bridge.js";
import { notifyRunStopRequested, onRunStopRequested } from "../run-stop-signals.js";
import {
  handleClientEvent,
  type AuthenticatedMobileClientEvent,
  type OrchestratorCtx,
} from "./handle-client-event.js";
import {
  MobileTurnQueueHost,
  runQueuedDispatch,
  type QueuedSessionAuthority,
} from "./turn-queue-host.js";

type Sent = { to: string; event: MobileServerEvent };
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const roots: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

const flush = async () => {
  // Several async hops (workspace, staging, worker acknowledgement) per submit.
  for (let index = 0; index < 20; index++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Authenticated sockets: viewerId -> deviceId, with per-viewer Session selection. */
function fakeRemote() {
  const sockets = new Map<string, string>();
  const selections = new Map<string, string>();
  const trusted = new Set<string>(["phone", "tablet", "laptop"]);
  const sent: Sent[] = [];
  const waiters = new Set<() => void>();
  const record = (item: Sent) => {
    sent.push(item);
    for (const waiter of [...waiters]) waiter();
  };
  /** Index of the first matching reply at or after `from`, waiting for it if needed. */
  const until = (predicate: (item: Sent) => boolean, from = 0): Promise<number> =>
    new Promise((resolve) => {
      const check = () => {
        const index = sent.findIndex((item, at) => at >= from && predicate(item));
        if (index < 0) return;
        waiters.delete(check);
        resolve(index);
      };
      waiters.add(check);
      check();
    });
  const remote = {
    sendToViewer: (viewerId: string, event: MobileServerEvent) => {
      if (sockets.has(viewerId)) record({ to: `viewer:${viewerId}`, event });
    },
    sendToDevice: (deviceId: string, event: MobileServerEvent) =>
      record({ to: `device:${deviceId}`, event }),
    broadcast: (event: MobileServerEvent) => record({ to: "all", event }),
    hasAuthenticatedViewer: (viewerId: string, deviceId: string) =>
      sockets.get(viewerId) === deviceId,
    onlineDeviceIds: () => [...new Set(sockets.values())],
  };
  return {
    remote,
    sent,
    until,
    trusted,
    connect: (viewerId: string, deviceId: string, sessionId?: string) => {
      sockets.set(viewerId, deviceId);
      if (sessionId) selections.set(viewerId, sessionId);
    },
    select: (viewerId: string, sessionId: string) => selections.set(viewerId, sessionId),
    disconnect: (viewerId: string) => {
      sockets.delete(viewerId);
      selections.delete(viewerId);
    },
    authorized: (viewerId: string, deviceId: string, sessionId: string) =>
      sockets.get(viewerId) === deviceId && selections.get(viewerId) === sessionId,
    of: (type: MobileServerEvent["type"]) => sent.filter((item) => item.event.type === type),
  };
}

/** A worker that records agent/run, acknowledges it, and stays busy until finished. */
function fakeWorker(onCancel?: (sessionId: string) => void) {
  const listeners = new Set<(line: string) => void>();
  const runs: Array<Record<string, unknown>> = [];
  const running = new Set<string>();
  const bridge = {
    getLastRunContext: () => ({}),
    subscribeOutbound: (listener: (line: string) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isSessionRunning: (sessionId: string) => running.has(sessionId),
    injectWorkerMessage: (line: string, _meta: WorkerFrameMeta) => {
      const request = JSON.parse(line) as {
        id: string;
        method: string;
        params: Record<string, unknown>;
      };
      if (request.method === "agent/cancel") {
        onCancel?.(String(request.params.sessionId));
        return;
      }
      if (request.method !== "agent/run") return;
      runs.push(request.params);
      running.add(String(request.params.sessionId));
      queueMicrotask(() => {
        const ack = JSON.stringify({
          method: "agent/runAccepted",
          params: { requestId: request.id },
        });
        for (const listener of listeners) listener(ack);
      });
    },
  } as unknown as AgentBridge;
  return { bridge, runs, running, finish: (sessionId: string) => running.delete(sessionId) };
}

function nativeHarness() {
  const sockets = fakeRemote();
  const stamps = new Map<string, string>([["session-1", "stamp-1"]]);
  const observed: AuthenticatedMobileClientEvent[] = [];
  /** Run inside awaited steps of a dispatch (authority lookup, handler workspace). */
  const hooks: {
    duringAuthority?: () => Promise<void> | void;
    duringWorkspace?: () => Promise<void> | void;
  } = {};
  const hostRef: { current?: MobileTurnQueueHost } = {};
  const pausedAtCancel: string[] = [];
  const worker = fakeWorker((sessionId) => {
    // The stop reaches the worker only after pending turns were paused.
    pausedAtCancel.push(
      hostRef.current?.queue.snapshot({ kind: "session", sessionId }).paused ?? "none",
    );
  });
  const ctx = {
    remote: sockets.remote,
    uploads: {
      claim: () => {
        throw new Error("unexpected upload claim");
      },
      release: async () => undefined,
      finalize: async () => undefined,
    },
    externalCommands: {
      observe: async (event: AuthenticatedMobileClientEvent) => {
        observed.push(event);
      },
      isExternal: () => false,
    },
    getBridge: () => worker.bridge,
    mobileSessionCwds: new Map(),
    mobilePermissionModes: new Map(),
    deviceState: () => ({ selectedSessionId: "session-1", selectedCwd: "/primary" }),
    ensureMobileSessionId: () => "session-1",
    lookupDiskSessionCwd: async () => undefined,
    effectiveMobileRunCwd: () => "/primary",
    validateMobileSessionCwd: async () => true,
    resolveSessionWorkspaceRoot: async () => {
      // An awaited step of the original handler, before the worker injection.
      await hooks.duringWorkspace?.();
      return "/primary";
    },
    sendMobilePermissionMode: () => undefined,
    sendSelectedMobilePermissionModes: () => undefined,
    replayPendingMobileApprovals: () => undefined,
    broadcastDesktopSessionSettings: () => undefined,
    broadcastMobileSession: () => undefined,
    broadcastApprovalResolved: () => undefined,
    settleMobileUploadClaims: async () => undefined,
  } as unknown as OrchestratorCtx;
  const host = new MobileTurnQueueHost({
    remote: sockets.remote,
    isSessionBusy: (id) => worker.running.has(id),
    isSessionAuthorized: sockets.authorized,
    captureSession: async (viewer, device, event) =>
      sockets.authorized(viewer, device, event.sessionId!)
        ? ({
            viewerBound: !!event.modelKey,
            ...(stamps.has(event.sessionId!) ? { stamp: stamps.get(event.sessionId!)! } : {}),
            deviceState: { selectedSessionId: event.sessionId!, selectedCwd: "/primary" },
          } satisfies QueuedSessionAuthority)
        : undefined,
    room: () => undefined,
    submit: (dispatch) =>
      runQueuedDispatch(dispatch, {
        ctx,
        isTrustedDevice: (deviceId) => sockets.trusted.has(deviceId),
        sessionAuthority: async (sessionId) => {
          // A slow project/Session authority lookup.
          await hooks.duringAuthority?.();
          const stamp = stamps.get(sessionId);
          if (!stamp) throw new Error("Session command authority changed");
          return {
            stamp,
            assertCurrent: () => {
              if (stamps.get(sessionId) !== stamp)
                throw new Error("Session command authority changed");
            },
          };
        },
        roomMode: () => undefined,
        handle: handleClientEvent,
      }),
    intervalMs: 0,
    settleMs: 0,
  });
  hostRef.current = host;
  cleanups.push(
    onRunStopRequested((sessionId) => host.pauseForStop({ kind: "session", sessionId })),
  );
  const deliver = async (event: AuthenticatedMobileClientEvent) => {
    host.observeViewer(event.viewerId, event.deviceId);
    if (host.control(event) || (await host.submit(event))) return;
    host.before(event);
    await handleClientEvent(ctx, event);
    host.after(event);
    await flush();
  };
  const selects = () => observed.filter((event) => event.type === "session.select");
  return { sockets, worker, host, deliver, stamps, selects, pausedAtCancel, hooks };
}

const chat = (
  text: string,
  overrides: Partial<Extract<AuthenticatedMobileClientEvent, { type: "chat.send" }>> = {},
): AuthenticatedMobileClientEvent => ({
  type: "chat.send",
  text,
  sessionId: "session-1",
  clientMessageId: `cm-${text}`,
  permissionMode: "default",
  viewerId: "phone-tab",
  deviceId: "phone",
  queue: true,
  ...overrides,
});
const sessionTarget = { kind: "session", sessionId: "session-1" } as const;

describe("Host turn queue over the real native submit path", () => {
  test("busy Session queues FIFO, sends nothing early, and runs each turn after the previous ends", async () => {
    const h = nativeHarness();
    h.sockets.connect("phone-tab", "phone", "session-1");
    h.worker.running.add("session-1");
    await h.deliver(chat("first", { permissionMode: "acceptEdits" }));
    await h.deliver(chat("second"));
    expect(h.worker.runs).toEqual([]);
    expect(h.sockets.of("chat.queued").map((item) => item.event)).toMatchObject([
      { clientMessageId: "cm-first", position: 0 },
      { clientMessageId: "cm-second", position: 1 },
    ]);
    expect(h.sockets.of("chat.accepted")).toEqual([]);

    h.worker.finish("session-1");
    await h.host.queue.pumpAll();
    await flush();
    expect(h.worker.runs.map((run) => run.task)).toEqual(["first"]);
    // The queued configuration snapshot is what runs.
    expect(h.worker.runs[0]).toMatchObject({
      sessionId: "session-1",
      clientMessageId: "cm-first",
      permissionMode: "acceptEdits",
    });
    await h.host.queue.pumpAll();
    expect(h.worker.runs).toHaveLength(1);
    h.worker.finish("session-1");
    await h.host.queue.pumpAll();
    await flush();
    expect(h.worker.runs.map((run) => run.task)).toEqual(["first", "second"]);
    expect(h.host.queue.has(sessionTarget)).toBe(false);
  });

  test("an idle Session runs immediately with the legacy acknowledgement only", async () => {
    const h = nativeHarness();
    h.sockets.connect("phone-tab", "phone", "session-1");
    await h.deliver(chat("now"));
    await flush();
    expect(h.worker.runs.map((run) => run.task)).toEqual(["now"]);
    expect(h.sockets.of("chat.queued")).toEqual([]);
    expect(h.sockets.of("chat.accepted").map((item) => item.event)).toMatchObject([
      { clientMessageId: "cm-now" },
    ]);
  });

  test("a queued turn runs exactly once after its tab navigates away, locks or disconnects", async () => {
    const h = nativeHarness();
    h.sockets.connect("phone-tab", "phone", "session-1");
    h.worker.running.add("session-1");
    await h.deliver(chat("later"));
    // The phone opens another conversation, then its socket drops (screen lock).
    h.sockets.select("phone-tab", "session-2");
    h.sockets.disconnect("phone-tab");
    h.host.releaseViewer("phone-tab");
    const selectsBefore = h.selects().length;
    h.worker.finish("session-1");
    await h.host.queue.pumpAll();
    await flush();
    expect(h.worker.runs.map((run) => run.task)).toEqual(["later"]);
    expect(h.worker.runs[0]).toMatchObject({ sessionId: "session-1", clientMessageId: "cm-later" });
    // No tab was re-selected onto the original Session (no navigation takeover).
    expect(h.selects()).toHaveLength(selectsBefore);
    await h.host.queue.pumpAll();
    expect(h.worker.runs).toHaveLength(1);
  });

  test("dispatch while the tab is navigating never re-selects the old Session", async () => {
    const h = nativeHarness();
    h.sockets.connect("phone-tab", "phone", "session-1");
    h.worker.running.add("session-1");
    await h.deliver(chat("queued"));
    h.worker.finish("session-1");
    const dispatching = h.host.queue.pumpAll();
    // The user switches conversations while the queued turn is being submitted.
    h.sockets.select("phone-tab", "session-2");
    await dispatching;
    await flush();
    expect(h.worker.runs.map((run) => run.task)).toEqual(["queued"]);
    expect(h.selects()).toEqual([]);
  });

  test("a revoked device or changed Session authority runs nothing and stays visible", async () => {
    for (const change of ["revoke", "authority"] as const) {
      const h = nativeHarness();
      h.sockets.connect("phone-tab", "phone", "session-1");
      h.worker.running.add("session-1");
      await h.deliver(chat("guarded"));
      if (change === "revoke") h.sockets.trusted.delete("phone");
      else h.stamps.set("session-1", "stamp-after-project-change");
      h.worker.finish("session-1");
      await h.host.queue.pumpAll();
      await flush();
      expect(h.worker.runs).toEqual([]);
      const state = h.host.queue.snapshot(sessionTarget);
      expect(state.paused).toBe("failed");
      expect(state.entries.map((entry) => entry.status)).toEqual(["failed"]);
    }
  });

  test("a revocation or Stop during an awaited dispatch step never reaches the worker", async () => {
    type Harness = ReturnType<typeof nativeHarness>;
    const cases: Array<{
      step: "duringAuthority" | "duringWorkspace";
      change: (h: Harness) => Promise<void> | void;
      stopped: boolean;
    }> = [
      {
        step: "duringAuthority",
        change: (h) => void h.sockets.trusted.delete("phone"),
        stopped: false,
      },
      {
        step: "duringWorkspace",
        change: (h) => void h.sockets.trusted.delete("phone"),
        stopped: false,
      },
      {
        step: "duringWorkspace",
        change: (h) => void h.stamps.set("session-1", "moved"),
        stopped: false,
      },
      { step: "duringAuthority", change: () => notifyRunStopRequested("session-1"), stopped: true },
      { step: "duringWorkspace", change: () => notifyRunStopRequested("session-1"), stopped: true },
      {
        step: "duringWorkspace",
        change: (h) =>
          h.deliver({
            type: "run.stop",
            sessionId: "session-1",
            viewerId: "phone-tab",
            deviceId: "phone",
          }),
        stopped: true,
      },
    ];
    for (const item of cases) {
      const h = nativeHarness();
      h.sockets.connect("phone-tab", "phone", "session-1");
      h.worker.running.add("session-1");
      await h.deliver(chat("fenced"));
      h.hooks[item.step] = async () => {
        h.hooks[item.step] = undefined;
        await item.change(h);
      };
      h.worker.finish("session-1");
      await h.host.queue.pumpAll();
      await flush();
      expect(h.worker.runs).toEqual([]);
      const state = h.host.queue.snapshot(sessionTarget);
      if (!item.stopped) {
        // A definite, visible refusal; nothing ran.
        expect(state.entries.map((entry) => entry.status)).toEqual(["failed"]);
        expect(state.entries[0]?.message).toContain("没有执行");
        continue;
      }
      // Stopped before any input: unchanged and paused, never failed or revived.
      expect(state.paused).toBe("stopped");
      expect(state.entries.map((entry) => [entry.status, entry.message])).toEqual([
        ["queued", undefined],
      ]);
      await h.host.queue.pumpAll();
      await flush();
      expect(h.worker.runs).toEqual([]);
      await h.deliver({
        type: "queue.resume",
        target: sessionTarget,
        viewerId: "phone-tab",
        deviceId: "phone",
      });
      await flush();
      expect(h.worker.runs.map((run) => run.task)).toEqual(["fenced"]);
      h.worker.finish("session-1");
      await h.host.queue.pumpAll();
      await flush();
      expect(h.worker.runs).toHaveLength(1);
    }
  });

  test("a Desktop or phone stop pauses pending turns before the stop is sent", async () => {
    for (const source of ["phone", "desktop"] as const) {
      const h = nativeHarness();
      h.sockets.connect("phone-tab", "phone", "session-1");
      h.worker.running.add("session-1");
      await h.deliver(chat("keep"));
      if (source === "phone")
        await h.deliver({
          type: "run.stop",
          sessionId: "session-1",
          viewerId: "phone-tab",
          deviceId: "phone",
        });
      // Desktop Stop reaches the shared run-stop signal (AgentBridge / external interrupt).
      else notifyRunStopRequested("session-1");
      if (source === "phone") expect(h.pausedAtCancel).toEqual(["stopped"]);
      h.worker.finish("session-1");
      await h.host.queue.pumpAll();
      await flush();
      expect(h.worker.runs).toEqual([]);
      expect(h.host.queue.snapshot(sessionTarget).paused).toBe("stopped");
      expect(h.host.queue.snapshot(sessionTarget).entries).toHaveLength(1);
      await h.deliver({
        type: "queue.resume",
        target: sessionTarget,
        viewerId: "phone-tab",
        deviceId: "phone",
      });
      await flush();
      expect(h.worker.runs.map((run) => run.task)).toEqual(["keep"]);
    }
  });

  test("state syncs to every authorized tab and controls require the Session authority", async () => {
    const h = nativeHarness();
    h.sockets.connect("phone-tab", "phone", "session-1");
    h.sockets.connect("tablet-tab", "tablet", "session-1");
    h.sockets.connect("other-tab", "laptop", "session-2");
    for (const [viewerId, deviceId] of [
      ["phone-tab", "phone"],
      ["tablet-tab", "tablet"],
      ["other-tab", "laptop"],
    ])
      h.host.observeViewer(viewerId, deviceId);
    h.worker.running.add("session-1");
    await h.deliver(chat("shared"));
    const states = h.sockets.of("queue.state");
    const latest = (viewer: string) =>
      states.filter((item) => item.to === `viewer:${viewer}`).at(-1)?.event as
        | Extract<MobileServerEvent, { type: "queue.state" }>
        | undefined;
    expect(latest("phone-tab")?.entries.map((entry) => entry.ownDevice)).toEqual([true]);
    expect(latest("tablet-tab")?.entries.map((entry) => entry.ownDevice)).toEqual([false]);
    expect(latest("other-tab")).toBeUndefined();

    const entryId = h.host.queue.snapshot(sessionTarget).entries[0]!.id;
    await h.deliver({
      type: "queue.cancel",
      target: sessionTarget,
      entryId,
      viewerId: "other-tab",
      deviceId: "laptop",
    });
    expect(h.host.queue.has(sessionTarget)).toBe(true);
    expect(h.sockets.of("queue.error").map((item) => item.to)).toEqual(["viewer:other-tab"]);
    await h.deliver({
      type: "queue.cancel",
      target: sessionTarget,
      entryId,
      viewerId: "tablet-tab",
      deviceId: "tablet",
    });
    expect(h.host.queue.has(sessionTarget)).toBe(false);
  });

  test("an unselected tab cannot enqueue; the legacy path reports its usual error", async () => {
    const h = nativeHarness();
    h.sockets.connect("phone-tab", "phone", "session-other");
    h.worker.running.add("session-1");
    expect(await h.host.submit(chat("sneak"))).toBe(false);
    expect(h.host.queue.has(sessionTarget)).toBe(false);
  });

  test("replays after reconnect neither duplicate nor rerun", async () => {
    const h = nativeHarness();
    h.sockets.connect("phone-tab", "phone", "session-1");
    h.worker.running.add("session-1");
    await h.deliver(chat("survives"));
    h.sockets.disconnect("phone-tab");
    h.host.releaseViewer("phone-tab");
    h.sockets.connect("phone-tab-2", "phone", "session-1");
    await h.deliver(chat("survives", { viewerId: "phone-tab-2" }));
    expect(h.host.queue.snapshot(sessionTarget).entries).toHaveLength(1);
    h.worker.finish("session-1");
    await h.host.queue.pumpAll();
    await flush();
    expect(h.worker.runs.map((run) => run.task)).toEqual(["survives"]);
    h.worker.finish("session-1");
    await h.deliver(chat("survives", { viewerId: "phone-tab-2" }));
    await h.host.queue.pumpAll();
    await flush();
    expect(h.worker.runs).toHaveLength(1);
    expect(h.sockets.of("chat.accepted").at(-1)).toMatchObject({
      to: "viewer:phone-tab-2",
      event: { clientMessageId: "cm-survives" },
    });
  });

  test("a turn bound to a live tab (runtime choice) waits for that device, never another", async () => {
    const h = nativeHarness();
    h.sockets.connect("phone-tab", "phone", "session-1");
    h.sockets.connect("tablet-tab", "tablet", "session-1");
    h.host.observeViewer("tablet-tab", "tablet");
    h.worker.running.add("session-1");
    await h.deliver(chat("bad", { modelKey: "not-a-runtime" }));
    await h.deliver(chat("tablet", { viewerId: "tablet-tab", deviceId: "tablet" }));
    h.sockets.disconnect("phone-tab");
    h.host.releaseViewer("phone-tab");
    h.worker.finish("session-1");
    await h.host.queue.pumpAll();
    await flush();
    // The tablet's own turn is not held back by the offline phone.
    expect(h.worker.runs.map((run) => run.task)).toEqual(["tablet"]);
    expect(h.host.queue.snapshot(sessionTarget).entries[0]?.status).toBe("waiting");
    h.worker.finish("session-1");
    h.sockets.connect("phone-tab-2", "phone", "session-1");
    h.host.observeViewer("phone-tab-2", "phone");
    await h.host.queue.pumpAll();
    await flush();
    // Back online, its invalid runtime choice is rejected by the original path.
    const state = h.host.queue.snapshot(sessionTarget);
    expect(h.worker.runs).toHaveLength(1);
    expect(state.paused).toBe("failed");
    expect(state.entries.map((entry) => entry.status)).toEqual(["failed"]);
  });
});

/** Claude-like resident accepts stdin while busy; Codex-like refuses and has a turn child. */
class CliAgent implements RoomAgent {
  running = false;
  sent: string[] = [];
  violations = 0;
  /** Codex: a turn child that can outlive its parsed turn_end. */
  child = false;
  isBusy?: () => boolean;
  constructor(
    private readonly emit: (event: ResidentAgentEvent) => void,
    private readonly perTurn: boolean,
  ) {
    if (perTurn) this.isBusy = () => this.child;
  }
  start() {
    this.running = true;
  }
  send(text: string) {
    if (this.perTurn && this.child) {
      this.violations += 1;
      return false;
    }
    this.child = this.perTurn;
    this.sent.push(text);
    return true;
  }
  turnEnd() {
    this.emit({ type: "turn_end", reason: "success" });
  }
  childExit() {
    this.child = false;
  }
  finish() {
    this.turnEnd();
    this.childExit();
  }
  crash() {
    this.running = false;
    this.child = false;
    this.emit({ type: "exit", code: 1, signal: null });
  }
  isRunning() {
    return this.running;
  }
  stop() {
    this.running = false;
  }
}

function fakeUploads(dir: string) {
  const files = new Map<
    string,
    { path: string; deviceId: string; state: "ready" | "claimed" | "gone"; claimId?: string }
  >();
  return {
    /** Runs when the handler claims an upload: inside attachment staging, before send. */
    onClaim: undefined as (() => void) | undefined,
    add(uploadId: string, deviceId = "phone") {
      const path = join(dir, `${uploadId}.png`);
      writeFileSync(path, PNG);
      files.set(uploadId, { path, deviceId, state: "ready" });
    },
    state: (uploadId: string) => files.get(uploadId)?.state,
    claim(deviceId: string, uploadId: string) {
      const file = files.get(uploadId);
      if (!file || file.state !== "ready" || file.deviceId !== deviceId)
        throw new Error("upload is not ready or no longer exists");
      file.state = "claimed";
      file.claimId = `claim-${uploadId}`;
      const onClaim = this.onClaim;
      this.onClaim = undefined;
      onClaim?.();
      return {
        uploadId,
        claimId: file.claimId,
        clientId: "img-1",
        name: "a.png",
        mime: "image/png",
        size: PNG.length,
        path: file.path,
        sha256: "0".repeat(64),
      };
    },
    async release(_deviceId: string, uploadId: string, claimId: string) {
      const file = files.get(uploadId);
      if (file?.claimId === claimId) file.state = "ready";
    },
    async finalize(_deviceId: string, uploadId: string, claimId: string) {
      const file = files.get(uploadId);
      if (file?.claimId !== claimId) return;
      file.state = "gone";
      rmSync(file.path, { force: true });
    },
    retain(deviceId: string, uploadId: string) {
      const file = files.get(uploadId);
      if (!file || file.state !== "ready" || file.deviceId !== deviceId)
        throw new Error("upload is not ready or no longer exists");
    },
    async discard(deviceId: string, uploadId: string) {
      const file = files.get(uploadId);
      if (!file || file.state !== "ready" || file.deviceId !== deviceId) return;
      file.state = "gone";
      rmSync(file.path, { force: true });
    },
  };
}

function roomHarness(kind: "claude-code" | "codex") {
  const root = tempDir("turn-queue-rooms-");
  const cwd = tempDir("turn-queue-cwd-");
  const sockets = fakeRemote();
  const agents: CliAgent[] = [];
  const hostRef: { current?: MobileTurnQueueHost } = {};
  const manager = new RoomManager({
    rootDir: root,
    createAgent: (_room, onEvent) => {
      const agent = new CliAgent(onEvent, kind === "codex");
      agents.push(agent);
      return agent;
    },
    onMessage: (roomId, msg) => hostRef.current?.observeRoomMessage(roomId, msg),
  });
  const room = manager.createRoom({
    cwd,
    kind,
    permissionMode: "default",
    claudeSessionId: `external-${kind}`,
  });
  const uploads = fakeUploads(tempDir("turn-queue-uploads-"));
  const ctx = {
    remote: sockets.remote,
    roomManager: manager,
    uploads,
    settleMobileUploadClaims: async (
      deviceId: string,
      claims: Array<{ uploadId: string; claimId: string }>,
      action: "release" | "finalize",
    ) => {
      for (const claim of claims) await uploads[action](deviceId, claim.uploadId, claim.claimId);
    },
  } as unknown as OrchestratorCtx;
  const host = new MobileTurnQueueHost({
    remote: sockets.remote,
    uploads,
    isSessionBusy: () => false,
    isSessionAuthorized: () => false,
    captureSession: async () => undefined,
    room: (roomId) => {
      const meta = manager.getRoom(roomId);
      return meta
        ? {
            observing: meta.linkedSessionMode === "observe-only",
            mode: manager.effectiveMode(roomId),
            busy: manager.isExecutionBusy(roomId),
          }
        : undefined;
    },
    submit: (dispatch) =>
      runQueuedDispatch(dispatch, {
        ctx,
        isTrustedDevice: (deviceId) => sockets.trusted.has(deviceId),
        sessionAuthority: async () => {
          throw new Error("rooms have no Session authority");
        },
        roomMode: (roomId) => manager.effectiveMode(roomId),
        handle: handleClientEvent,
      }),
    intervalMs: 0,
    settleMs: 0,
  });
  hostRef.current = host;
  manager.setHostTurnHooks({
    hasPendingTurns: (roomId) => host.hasPendingTurns({ kind: "room", roomId }),
    beforeClose: (roomId) => host.pauseForStop({ kind: "room", roomId }),
  });
  const deliver = async (event: AuthenticatedMobileClientEvent) => {
    host.observeViewer(event.viewerId, event.deviceId);
    if (!host.control(event) && !(await host.submit(event))) {
      host.before(event);
      await handleClientEvent(ctx, event);
      host.after(event);
    }
    // Let an immediately started submission reach the CLI.
    await flush();
  };
  type RoomSend = Extract<AuthenticatedMobileClientEvent, { type: "room.send" }>;
  const send = (text: string, extra: Partial<RoomSend> = {}): RoomSend => ({
    type: "room.send",
    roomId: room.id,
    text,
    clientMessageId: `cm-${text}`,
    viewerId: "phone-tab",
    deviceId: "phone",
    queue: true,
    ...extra,
  });
  const target: MobileTurnQueueTarget = { kind: "room", roomId: room.id };
  const userLines = () =>
    manager
      .getMessages(room.id, 0)
      .filter((message) => message.from === "user")
      .map((message) => message.text);
  sockets.connect("phone-tab", "phone");
  return { sockets, agents, manager, room, cwd, host, deliver, send, target, uploads, userLines };
}

for (const kind of ["claude-code", "codex"] as const) {
  describe(`Host turn queue over a real ${kind} CLI room`, () => {
    test("only an idle room receives the next turn; queued text never reaches the CLI early", async () => {
      const h = roomHarness(kind);
      await h.deliver(h.send("one"));
      expect(h.agents[0]?.sent).toEqual(["one"]);
      await h.deliver(h.send("two"));
      await h.deliver(h.send("three"));
      expect(h.sockets.of("chat.queued")).toHaveLength(2);
      await h.host.queue.pumpAll();
      expect(h.agents[0]?.sent).toEqual(["one"]);
      h.agents[0]!.finish();
      await h.host.queue.pumpAll();
      await flush();
      expect(h.agents[0]?.sent).toEqual(["one", "two"]);
      h.agents[0]!.finish();
      await h.host.queue.pumpAll();
      await flush();
      expect(h.agents[0]?.sent).toEqual(["one", "two", "three"]);
      expect(h.agents[0]?.violations).toBe(0);
      expect(h.userLines()).toEqual(["one", "two", "three"]);
      // Deferred turns never act through the tab's current selection.
      expect(h.sockets.of("room.accepted").map((item) => item.to)).toEqual([
        "viewer:phone-tab",
        "device:phone",
        "device:phone",
      ]);
    });

    test("idleness is the room's own state, not a stream message", async () => {
      const h = roomHarness(kind);
      await h.deliver(h.send("running"));
      await h.deliver(h.send("next"));
      const agent = h.agents[0]!;
      // A non-terminal stderr error does not end the turn.
      (agent as unknown as { emit: (e: ResidentAgentEvent) => void }).emit({
        type: "error",
        error: "transient stderr",
      });
      await h.host.queue.pumpAll();
      await flush();
      expect(agent.sent).toEqual(["running"]);
      agent.turnEnd();
      await h.host.queue.pumpAll();
      await flush();
      if (kind === "codex") {
        // Codex parsed turn_end, but its turn child is still alive.
        expect(agent.sent).toEqual(["running"]);
        expect(agent.violations).toBe(0);
        agent.childExit();
        await h.host.queue.pumpAll();
        await flush();
      }
      expect(agent.sent).toEqual(["running", "next"]);
      expect(h.host.queue.snapshot(h.target).paused).toBeUndefined();
    });

    test("a pending approval and other accepted inputs keep the room busy", async () => {
      const h = roomHarness(kind);
      await h.deliver(h.send("first"));
      const agent = h.agents[0]!;
      if (kind === "claude-code") {
        // Desktop fed a second input to the same resident process directly.
        expect(h.manager.send(h.room.id, "direct from desktop")).toBe(true);
      }
      await h.deliver(h.send("queued"));
      agent.finish();
      (agent as unknown as { emit: (e: ResidentAgentEvent) => void }).emit({
        type: "approval_request",
        requestId: "req-1",
        toolName: "Bash",
        input: { command: "ls" },
      });
      await h.host.queue.pumpAll();
      await flush();
      expect(agent.sent).not.toContain("queued");
      h.manager.respondApproval(h.room.id, "req-1", { behavior: "deny", message: "no" });
      await h.host.queue.pumpAll();
      await flush();
      if (kind === "claude-code") {
        // One accepted input still has no result.
        expect(agent.sent).not.toContain("queued");
        agent.finish();
        await h.host.queue.pumpAll();
        await flush();
      }
      expect(agent.sent.at(-1)).toBe("queued");
      expect(agent.violations).toBe(0);
    });

    test("an accepted input whose recording failed is never resubmitted", async () => {
      const h = roomHarness(kind);
      await h.deliver(h.send("busy"));
      await h.deliver(h.send("once"));
      h.agents[0]!.finish();
      const internal = h.manager as unknown as { append: (...args: unknown[]) => unknown };
      const original = internal.append.bind(h.manager);
      internal.append = () => {
        throw new Error("disk full");
      };
      await h.host.queue.pumpAll();
      await flush();
      internal.append = original;
      const state = h.host.queue.snapshot(h.target);
      expect(h.agents[0]?.sent).toEqual(["busy", "once"]);
      expect(state.paused).toBe("uncertain");
      expect(state.entries.map((entry) => entry.status)).toEqual(["uncertain"]);
      const entryId = state.entries[0]!.id;
      for (const type of ["queue.retry", "queue.resume"] as const)
        await h.deliver({
          type,
          target: h.target,
          ...(type === "queue.retry" ? { entryId } : {}),
          viewerId: "phone-tab",
          deviceId: "phone",
        } as AuthenticatedMobileClientEvent);
      // A replay of the same intent is the same turn, not a second input.
      await h.deliver(h.send("once"));
      h.agents[0]!.finish();
      await h.host.queue.pumpAll();
      await flush();
      expect(h.agents[0]?.sent).toEqual(["busy", "once"]);
      expect(h.sockets.of("queue.error").length).toBeGreaterThanOrEqual(2);
    });

    test("an image turn's receipt answers a lost-ack replay after its upload was consumed", async () => {
      for (const deferred of [false, true]) {
        const h = roomHarness(kind);
        const image = (uploadId: string) => ({
          attachments: [
            {
              transport: "upload" as const,
              uploadId,
              clientId: "img-1",
              name: "a.png",
              mime: "image/png" as const,
              size: PNG.length,
            },
          ],
        });
        const picture = () => h.send("picture", image("up-1"));
        if (deferred) await h.deliver(h.send("busy"));
        h.uploads.add("up-1");
        const start = h.sockets.sent.length;
        // Real staging/finalize is file I/O: wait on the handler's own
        // completion signals instead of a fixed number of ticks.
        const accepted = h.sockets.until(
          (item) =>
            item.event.type === "room.accepted" && item.event.clientMessageId === "cm-picture",
          start,
        );
        await h.host.submit(picture());
        if (deferred) {
          h.agents[0]!.finish();
          void h.host.queue.pumpAll();
        }
        // A replay while the turn is still being submitted is the same turn.
        expect(await h.host.submit(picture())).toBe(true);
        const acceptedAt = await accepted;
        // The handler finalizes the upload before acknowledging.
        expect(h.uploads.state("up-1")).toBe("gone");
        // ...and the queue records the receipt when the submit path returns.
        await h.sockets.until(
          (item) => item.event.type === "queue.state" && item.event.entries.length === 0,
          acceptedAt + 1,
        );
        const sentBefore = h.agents.flatMap((agent) => agent.sent);
        await h.deliver(picture());
        expect(h.agents.flatMap((agent) => agent.sent)).toEqual(sentBefore);
        expect(sentBefore.filter((text) => text.startsWith("picture"))).toHaveLength(1);
        expect(h.sockets.of("room.accepted").at(-1)).toMatchObject({
          to: "viewer:phone-tab",
          event: { clientMessageId: "cm-picture" },
        });
        expect(h.sockets.of("room.error")).toEqual([]);
      }
    });

    test("a close, Stop or revocation during image staging never sends or reopens", async () => {
      for (const change of ["desktop-close", "phone-close", "revoke"] as const) {
        const h = roomHarness(kind);
        await h.deliver(h.send("running"));
        h.uploads.add("up-2");
        await h.deliver(
          h.send("photo", {
            attachments: [
              {
                transport: "upload",
                uploadId: "up-2",
                clientId: "img-1",
                name: "a.png",
                mime: "image/png",
                size: PNG.length,
              },
            ],
          }),
        );
        const start = h.sockets.sent.length;
        // The change lands while the queued turn's image is being staged.
        h.uploads.onClaim = () => {
          if (change === "desktop-close") h.manager.close(h.room.id);
          else if (change === "phone-close")
            void h.deliver({
              type: "room.close",
              roomId: h.room.id,
              viewerId: "phone-tab",
              deviceId: "phone",
            });
          else h.sockets.trusted.delete("phone");
        };
        h.agents[0]!.finish();
        void h.host.queue.pumpAll();
        await h.sockets.until(
          (item) => item.event.type === "room.error" && item.event.clientMessageId === "cm-photo",
          start,
        );
        await h.host.queue.pumpAll();
        await flush();
        // Zero input and zero (re)start: only the original process ever ran.
        expect(h.agents).toHaveLength(1);
        expect(h.agents[0]?.sent).toEqual(["running"]);
        // The staged claim was released, never consumed.
        expect(h.uploads.state("up-2")).toBe("ready");
        const state = h.host.queue.snapshot(h.target);
        if (change === "revoke") {
          expect(state.entries.map((entry) => entry.status)).toEqual(["failed"]);
          continue;
        }
        expect(h.manager.isOpen(h.room.id)).toBe(false);
        expect(state.paused).toBe("stopped");
        expect(state.entries.map((entry) => entry.status)).toEqual(["queued"]);
        // An explicit resume runs it exactly once.
        await h.deliver({
          type: "queue.resume",
          target: h.target,
          viewerId: "phone-tab",
          deviceId: "phone",
        });
        await h.sockets.until(
          (item) =>
            item.event.type === "room.accepted" && item.event.clientMessageId === "cm-photo",
          start,
        );
        const photos = h.agents.flatMap((agent) => agent.sent).filter((t) => t.startsWith("photo"));
        expect(photos).toHaveLength(1);
      }
    });

    test("an abnormal CLI exit does not strand the next turn", async () => {
      const h = roomHarness(kind);
      await h.deliver(h.send("before crash"));
      await h.deliver(h.send("after crash"));
      h.agents[0]!.crash();
      await h.host.queue.pumpAll();
      await flush();
      expect(h.agents).toHaveLength(2);
      expect(h.agents[1]?.sent).toEqual(["after crash"]);
    });

    test("any close (phone or Desktop) pauses pending turns until an explicit resume", async () => {
      for (const source of ["phone", "desktop"] as const) {
        const h = roomHarness(kind);
        await h.deliver(h.send("running"));
        await h.deliver(h.send("held"));
        if (source === "phone")
          await h.deliver({
            type: "room.close",
            roomId: h.room.id,
            viewerId: "phone-tab",
            deviceId: "phone",
          });
        else h.manager.close(h.room.id);
        await h.host.queue.pumpAll();
        await flush();
        expect(h.host.queue.snapshot(h.target).paused).toBe("stopped");
        expect(h.agents.flatMap((agent) => agent.sent)).toEqual(["running"]);
        await h.deliver({
          type: "queue.resume",
          target: h.target,
          viewerId: "phone-tab",
          deviceId: "phone",
        });
        await flush();
        expect(h.agents.at(-1)?.sent).toEqual(["held"]);
      }
    });

    test("a pending turn blocks every permission-mode change; a changed mode is never used", async () => {
      const h = roomHarness(kind);
      await h.deliver(h.send("running"));
      await h.deliver(h.send("pending"));
      h.manager.close(h.room.id);
      await flush();
      expect(h.host.queue.snapshot(h.target).entries[0]?.permissionMode).toBe("default");
      for (const mode of ["bypassPermissions", "acceptEdits"] as const)
        await expect(
          h.manager.openForSession(`external-${kind}`, h.cwd, mode, kind),
        ).rejects.toBeInstanceOf(RoomBusyError);
      expect(h.manager.getRoom(h.room.id)?.permissionMode).toBe("default");
      expect(h.agents).toHaveLength(1);
      // Without the Host hook the mode changes; the queued turn must not run under it.
      h.manager.setHostTurnHooks({});
      await h.manager.openForSession(`external-${kind}`, h.cwd, "acceptEdits", kind);
      const runs = h.agents.flatMap((agent) => agent.sent);
      await h.deliver({
        type: "queue.resume",
        target: h.target,
        viewerId: "phone-tab",
        deviceId: "phone",
      });
      await flush();
      expect(h.agents.flatMap((agent) => agent.sent)).toEqual(runs);
      expect(h.host.queue.snapshot(h.target).entries.map((entry) => entry.status)).toEqual([
        "failed",
      ]);
    });

    test("an observe-only room is never queued", async () => {
      const h = roomHarness(kind);
      const linked = h.manager.createRoom({
        cwd: h.cwd,
        kind,
        permissionMode: "default",
        claudeSessionId: "linked",
        linkedSessionMode: "observe-only",
      });
      expect(await h.host.submit(h.send("blocked", { roomId: linked.id }))).toBe(false);
      expect(h.host.queue.has({ kind: "room", roomId: linked.id })).toBe(false);
    });
  });
}
