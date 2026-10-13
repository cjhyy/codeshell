import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
const deny = (..._args: unknown[]): never => { throw new Error("NETWORK_FORBIDDEN"); };
globalThis.fetch = deny as typeof fetch;
http.request = deny as typeof http.request; http.get = deny as typeof http.get;
https.request = deny as typeof https.request; https.get = deny as typeof https.get;
net.connect = deny as typeof net.connect; net.createConnection = deny as typeof net.createConnection;
tls.connect = deny as typeof tls.connect;
if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-")) throw new Error("guarded runner with isolated HOME required");
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const { RoomManager } = await import(repo + "/packages/server/src/mobile-remote/room-manager.ts");
const { ResidentAgentProcess } = await import(repo + "/packages/server/src/mobile-remote/resident-agent.ts");
const { resolveRoomPermissionMode } = await import(repo + "/packages/desktop/src/main/mobile-remote/handle-room-event.ts");
const { writeSettings } = await import(repo + "/packages/desktop/src/main/settings-service.ts");
const { ensureMiniDom, flushMicrotasks, renderHook } = await import(repo + "/packages/desktop/src/renderer/test-utils/renderHook.tsx");
const { INITIAL_STATE } = await import(repo + "/packages/desktop/src/renderer/types.ts");
const { NO_REPO_KEY, saveSessionIndex } = await import(repo + "/packages/desktop/src/renderer/transcripts.ts");
const { useRunController } = await import(repo + "/packages/desktop/src/renderer/app/useRunController.ts");
const { resetExternalRuntimeSessions } = await import(repo + "/packages/desktop/src/renderer/externalRuntimeRun.ts");
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; resetExternalRuntimeSessions(); });
const settle = async () => { await act(async () => { await flushMicrotasks(); await new Promise(r => setTimeout(r, 10)); await flushMicrotasks(); }); };
const until = async (condition: () => boolean, name: string) => { const started = Date.now(); while (!condition()) { if (Date.now() - started > 2000) throw new Error(`timeout: ${name}`); await settle(); } };
function setup(reply: () => Promise<unknown>) {
  ensureMiniDom();
  const storage = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
  });
  const actions: any[] = [];
  const toasts: any[] = [];
  let busy = false;
  const noop = () => {};
  Object.assign(window, {
    codeshell: {
      log: noop,
      registerBrowserSessionBucket: noop,
      cancel: async () => {},
      run: reply,
    },
  });
  const index = {
    sessions: [
      { id: "A", title: "会话 A", createdAt: 1, updatedAt: 1 },
      { id: "B", title: "会话 B", createdAt: 1, updatedAt: 1 },
    ],
    activeSessionId: "A",
  };
  saveSessionIndex(null, index);
  const params: any = {
    shell: { t: (key) => key, lang: "zh", toast: (x) => toasts.push(x), setView: noop },
    session: {
      activeProjectId: null,
      activeSessionId: "A",
      activeBucket: `${NO_REPO_KEY}::A`,
      projects: [],
      sessionIndices: { [NO_REPO_KEY]: index },
      setSessionIndices: noop,
      ensureActiveSession: () => "A",
    },
    preferences: {
      permissionOverrides: {},
      setPermissionOverrides: noop,
      defaultPermissionMode: null,
      goalOverrides: {},
      setGoalOverrides: noop,
      modelOverrides: {},
      setModelOverrides: noop,
      defaultActiveModelKey: null,
      quickChatDefaultModelKey: null,
    },
    runtime: {
      setBusyForKey: (_key, v) => {
        busy = v;
      },
      runningBucketRef: { current: null },
      engineToBucketRef: { current: new Map() },
      noRepoCwdRef: { current: "/tmp" },
      quickChatSessionsRef: { current: {} },
      queuedInputs: {},
      setQueuedInputs: noop,
      busy: false,
      busyKeys: new Set(),
      relayingBuckets: new Set(),
      setRelayingBuckets: noop,
      steeredIdsRef: { current: new Set() },
      injectedSteerIdsRef: { current: new Set() },
      downgradeRunQueueRef: { current: { tail: Promise.resolve() } },
      queuedSeqRef: { current: 0 },
      busySinceRef: { current: new Map() },
      compactingBucketsRef: { current: new Set() },
      setCompactingBuckets: noop,
    },
    transcript: { dispatch: (a) => actions.push(a), state: INITIAL_STATE },
    approvals: {
      approval: null,
      approvalQueue: [],
      setApprovalQueue: noop,
      setApproval: noop,
      setApprovalHistory: noop,
      approvalBucketsRef: { current: new Map() },
    },
  };
  return { params, actions, toasts, isBusy: () => busy };
}

test("R02 boundary: real server downgrades untrusted bypass; trusted explicit bypass is admitted and explicit default is honored", async () => {
  const root = mkdtempSync(join(tmpdir(), "codeshell-cli-permission-"));
  try {
    await writeSettings("user", { externalAgents: { claudeCode: { trustedWorkspaces: [] } } });
    expect(await resolveRoomPermissionMode(root, "bypassPermissions")).toBe("default");
    await writeSettings("user", { externalAgents: { claudeCode: { trustedWorkspaces: [root] } } });
    expect(await resolveRoomPermissionMode(root, "bypassPermissions")).toBe("bypassPermissions");
    expect(await resolveRoomPermissionMode(root, "default")).toBe("default");
    expect(await resolveRoomPermissionMode(root, "acceptEdits")).toBe("acceptEdits");
    console.log("R02_TRUST_BOUNDARY", JSON.stringify({ untrustedExplicitBypass: "default", trustedExplicitBypass: "bypassPermissions", trustedExplicitDefault: "default" }));
  } finally { await writeSettings("user", { externalAgents: { claudeCode: { trustedWorkspaces: [] } } }); rmSync(root, { recursive: true, force: true }); }
});

test("R18 narrow recovery: failed async spawn blocks same-mode reopen, but mode change and explicit close each respawn after repair", async () => {
  const root = mkdtempSync(join(tmpdir(), "codeshell-cli-spawn-recovery-"));
  const command = join(root, "inert-fixture-cli");
  let created = 0, errors = 0;
  const manager = new RoomManager({ rootDir: join(root, "rooms"), createAgent: (room, onEvent) => {
    created++; return new ResidentAgentProcess({ command, cwd: room.cwd, permissionMode: room.permissionMode, onEvent });
  }, onMessage: (_id, message) => { if (message.type === "error") errors++; } });
  try {
    const initial = manager.openForSession("fixture-external-session", root, "default", "claude-code");
    expect(initial.status).toBe("running");
    await until(() => errors > 0, "failed spawn error");
    writeFileSync(command, "#!/bin/sh\ncat >/dev/null\n"); chmodSync(command, 0o700);
    const same = manager.openForSession("fixture-external-session", root, "default", "claude-code");
    expect(same.roomId).toBe(initial.roomId); expect(same.status).toBe("running"); expect(created).toBe(1);
    expect(manager.send(initial.roomId, "same-mode retry")).toBe(false);
    const changed = manager.openForSession("fixture-external-session", root, "acceptEdits", "claude-code");
    await settle();
    expect(changed.roomId).toBe(initial.roomId); expect(created).toBe(2);
    expect(manager.getRoom(initial.roomId)?.permissionMode).toBe("acceptEdits");
    expect(manager.send(initial.roomId, "after mode change")).toBe(true);
    manager.close(initial.roomId);
    expect(manager.isOpen(initial.roomId)).toBe(false);
    const closed = manager.openForSession("fixture-external-session", root, "acceptEdits", "claude-code");
    await settle();
    expect(closed.roomId).toBe(initial.roomId); expect(created).toBe(3);
    expect(manager.send(initial.roomId, "after explicit close")).toBe(true);
    console.log("R18_RECOVERY_BOUNDARY", JSON.stringify({ sameModeCreated: 1, sameModeSend: false, afterModeChangeCreated: 2, afterModeChangeSend: true, afterExplicitCloseCreated: 3, afterExplicitCloseSend: true }));
  } finally { manager.closeAll(); await settle(); rmSync(root, { recursive: true, force: true }); }
});

test("R15 boundary: foreground queue drains on completion; background queue waits until A is selected again; no backend submission exists meanwhile", async () => {
  const f = setup(async () => { throw new Error("unexpected native send"); });
  const A = `${NO_REPO_KEY}::A`, B = `${NO_REPO_KEY}::B`;
  const starts: any[] = [], sends: any[] = [], steers: any[] = [];
  window.codeshell.externalRuntime = { start: async (payload: any) => { starts.push(payload); return { kind: "codex", runtimeSessionId: null, tools: [] }; }, send: async (payload: any) => { sends.push(payload); return { ok: true, reason: "completed" }; } } as any;
  window.codeshell.steer = async (...args: any[]) => { steers.push(args); return { result: { accepted: true } }; };
  f.params.preferences.defaultActiveModelKey = "codex/gpt-5.6-sol";
  f.params.runtime.busy = true; f.params.runtime.busyKeys = new Set([A]);
  f.params.runtime.setQueuedInputs = (next: any) => { f.params.runtime.queuedInputs = typeof next === "function" ? next(f.params.runtime.queuedInputs) : next; };
  const h = await renderHook(() => useRunController(f.params)); cleanup = h.unmount;
  await act(async () => { h.result.current.queueInput("queued while foreground"); await flushMicrotasks(); });
  await h.rerender(); await settle();
  expect(f.params.runtime.queuedInputs[A]).toHaveLength(1); expect(steers).toHaveLength(0); expect(sends).toHaveLength(0);
  f.params.runtime.busy = false; f.params.runtime.busyKeys = new Set();
  await h.rerender(); await until(() => sends.length === 1, "foreground queue drain");
  expect(sends[0].sessionId).toBe("A"); expect(sends[0].text).toBe("queued while foreground");
  expect(f.params.runtime.queuedInputs[A] ?? []).toHaveLength(0);
  f.params.runtime.busy = true; f.params.runtime.busyKeys = new Set([A]);
  await h.rerender();
  await act(async () => { h.result.current.queueInput("queued before switch"); await flushMicrotasks(); });
  await h.rerender(); await settle();
  expect(f.params.runtime.queuedInputs[A]).toHaveLength(1); expect(sends).toHaveLength(1); expect(steers).toHaveLength(0);
  f.params.session.activeSessionId = "B"; f.params.session.activeBucket = B; f.params.runtime.busy = false;
  await h.rerender(); await settle();
  f.params.runtime.busyKeys = new Set();
  await h.rerender(); await settle();
  expect(sends).toHaveLength(1); expect(f.params.runtime.queuedInputs[A]).toHaveLength(1);
  f.params.session.activeSessionId = "A"; f.params.session.activeBucket = A;
  await h.rerender(); await until(() => sends.length === 2, "reselect A drains queue");
  expect(sends[1].sessionId).toBe("A"); expect(sends[1].text).toBe("queued before switch"); expect(starts).toHaveLength(1);
  console.log("R15_FOREGROUND_BOUNDARY", JSON.stringify({ firstForegroundSend: sends[0].text, whileBackgroundSendCount: 1, afterReselectSendCount: sends.length, runtimeStarts: starts.length }));
});
