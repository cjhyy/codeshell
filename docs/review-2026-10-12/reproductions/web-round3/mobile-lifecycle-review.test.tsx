import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureMiniDom,
  flushMicrotasks,
  renderHook,
} from "../../../../packages/web/src/test-utils/renderHook.tsx";
import { useRemoteSocket } from "../../../../packages/web/src/hooks/useRemoteSocket.ts";
import { useRemoteApp } from "../../../../packages/web/src/hooks/useRemoteApp.ts";
import { useDesktopController } from "../../../../packages/web/app/DesktopApp.tsx";
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new Error("Network disabled for mobile review fixture");
}) as typeof fetch;
const { RemoteHostManager } =
  await import("../../../../packages/server/src/mobile-remote/remote-host-manager.ts");
const { TrustedDeviceStore } =
  await import("../../../../packages/server/src/mobile-remote/trusted-device-store.ts");
const { MobileUploadService } =
  await import("../../../../packages/server/src/mobile-remote/mobile-upload-service.ts");
const { handleClientEvent } =
  await import("../../../../packages/desktop/src/main/mobile-remote/handle-client-event.ts");
const { MobileExternalRuntimeCommands } =
  await import("../../../../packages/desktop/src/main/mobile-remote/external-runtime-commands.ts");
const { prepareAgentRunMetadata } =
  await import("../../../../packages/desktop/src/main/agent-run-metadata.ts");
const { createWorkspaceContext } = await import("@cjhyy/code-shell-core/internal");

class MemoryStorage {
  values = new Map<string, string>([
    ["cs.deviceId", "fixture-device"],
    ["cs.deviceSecret", "fixture-secret"],
    ["cs.deviceName", "Fixture"],
  ]);
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}
class Socket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: Socket[] = [];
  readyState = 0;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    Socket.instances.push(this);
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  message(frame: any) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}
const cleanups: Array<() => void | Promise<void>> = [];
function property(target: object, key: string, value: any) {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  cleanups.push(() => {
    if (previous) Object.defineProperty(target, key, previous);
    else Reflect.deleteProperty(target, key);
  });
}
function setup(
  storage = new MemoryStorage(),
  location: any = { origin: "http://fixture.invalid", pathname: "/mobile/", search: "" },
) {
  ensureMiniDom();
  Socket.instances = [];
  property(globalThis, "WebSocket", Socket);
  property(globalThis, "localStorage", storage);
  property(window, "location", location);
  property(window, "history", {
    replaceState(_a: any, _b: any, path: string) {
      location.search = "";
      location.pathname = path;
    },
  });
  property(window, "fetch", globalThis.fetch);
}
async function connect() {
  setup();
  const hook = await renderHook(() => {
    const app = useRemoteApp();
    return { app, controller: useDesktopController(app, undefined, () => {}) };
  });
  cleanups.push(() => hook.unmount());
  const socket = Socket.instances.at(-1)!;
  await act(async () => {
    socket.open();
    socket.message({
      type: "auth.ok",
      device: { id: "fixture-device", name: "Fixture" },
      capabilities: { outputJournal: 1 },
    });
    await flushMicrotasks();
  });
  return { hook, socket };
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

test("confirmed: quota-exhausted localStorage changes the credential between pair.complete and auth.device", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codeshell-review-20261012-web-round3-pair-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const devices = new TrustedDeviceStore(join(directory, "devices.json"));
  const host = new RemoteHostManager({ devices, onClientEvent() {} });
  await host.start({ host: "127.0.0.1", port: 0 });
  cleanups.push(() => host.stop());
  const pairing = host.createPairingUrl();
  const address = new URL(pairing.url);
  const storage = new MemoryStorage();
  storage.values.clear();
  storage.setItem = () => {
    throw new DOMException("Fixture quota exhausted", "QuotaExceededError");
  };
  setup(storage, { origin: address.origin, pathname: address.pathname, search: address.search });
  const hook = await renderHook(() => useRemoteSocket({}));
  cleanups.push(() => hook.unmount());
  const socket = Socket.instances.at(-1)!;
  await act(async () => {
    socket.open();
    await flushMicrotasks();
  });
  const pairFrame = socket.sent.at(-1);
  expect(pairFrame.type).toBe("pair.complete");
  const paired = host.handleClientEvent(pairFrame)!;
  expect(paired.type).toBe("pair.ok");
  await act(async () => {
    socket.message(paired);
    await flushMicrotasks();
  });
  const authFrame = socket.sent.at(-1);
  expect(authFrame.type).toBe("auth.device");
  expect(authFrame.secretHash).not.toBe(pairFrame.secretHash);
  const auth = host.handleClientEvent(authFrame)!;
  expect(auth.type).toBe("auth.failed");
  await act(async () => {
    socket.message(auth);
    await flushMicrotasks();
  });
  expect(hook.result.current.status).toBe("unpaired");
  expect(devices.listDevices()).toHaveLength(1);
  console.log(
    "QUOTA_PAIRING",
    JSON.stringify({
      pairResult: paired.type,
      credentialChanged: true,
      authResult: auth.type,
      finalStatus: hook.result.current.status,
      unusedDeviceRows: devices.listDevices().length,
    }),
  );
});

test("confirmed: an unrelated native session stream steals a new conversation draft before create acknowledgement", async () => {
  const { hook, socket } = await connect();
  await act(async () => {
    hook.result.current.controller.selectSession("prior");
    await flushMicrotasks();
  });
  await act(async () => {
    hook.result.current.controller.newSession();
    await flushMicrotasks();
  });
  const creation = socket.sent.filter((frame) => frame.type === "session.create").at(-1);
  expect(creation.clientRequestId).toBeString();
  const localId = hook.result.current.controller.activeId;
  await act(async () => {
    hook.result.current.controller.setDraft("Draft intended for my newly-created conversation");
    await flushMicrotasks();
  });
  // This is the production broadcast envelope from Desktop index.ts:1733-1746.
  await act(async () => {
    socket.message({
      type: "session.stream",
      sessionId: "unrelated-background",
      seq: 1,
      epoch: "main-fixture",
      event: { type: "stream_request_start", outputCursor: "out-1" },
    });
    await flushMicrotasks();
  });
  expect(hook.result.current.controller.activeId).toBe("unrelated-background");
  expect(hook.result.current.controller.draft).toBe(
    "Draft intended for my newly-created conversation",
  );
  await act(async () => {
    socket.message({
      type: "chat.accepted",
      clientRequestId: creation.clientRequestId,
      sessionId: "actually-created",
      cwd: null,
    });
    await flushMicrotasks();
  });
  expect(hook.result.current.controller.activeId).toBe("actually-created");
  expect(hook.result.current.controller.draft).toBe("");
  expect(hook.result.current.controller.localDrafts).toHaveLength(0);
  await act(async () => {
    hook.result.current.controller.selectSession("unrelated-background");
    await flushMicrotasks();
  });
  expect(hook.result.current.controller.draft).toBe(
    "Draft intended for my newly-created conversation",
  );
  console.log(
    "NEW_SESSION_DRAFT_STOLEN",
    JSON.stringify({
      initialDraftId: localId,
      intermediateBinding: "unrelated-background",
      createdBinding: "actually-created",
      draftRecoveredOnlyIn: "unrelated-background",
    }),
  );
});

test("confirmed: disconnect does not abort a ticketed HTTP upload and blocks later sends after reconnect", async () => {
  const { hook, socket } = await connect();
  await act(async () => {
    hook.result.current.controller.selectSession("native");
    await flushMicrotasks();
  });
  const directory = mkdtempSync(join(tmpdir(), "codeshell-review-20261012-web-round3-upload-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const uploads = new MobileUploadService({
    rootDir: join(directory, "spool"),
    cleanupIntervalMs: 0,
  });
  await uploads.ready();
  cleanups.push(() => uploads.dispose());
  let rejectPut!: (cause: Error) => void;
  let putInit: RequestInit | undefined;
  property(window, "fetch", (async (_url: any, init: any) => {
    putInit = init;
    return new Promise<Response>((_resolve, reject) => {
      rejectPut = reject;
    });
  }) as typeof fetch);
  const image = new File([new Uint8Array(300 * 1024)], "photo.png", { type: "image/png" });
  await act(async () => {
    hook.result.current.controller.setDraft("image task");
    hook.result.current.controller.addFiles([image] as any);
    await flushMicrotasks();
  });
  await act(async () => {
    expect(hook.result.current.controller.send()).toBe(true);
    await flushMicrotasks();
  });
  const begin = socket.sent.find((frame) => frame.type === "attachment.upload.begin");
  expect(begin).toBeTruthy();
  const ticket = uploads.begin("fixture-device", begin);
  expect(ticket.expiresAt - Date.now()).toBeGreaterThan(290000);
  await act(async () => {
    socket.message({ type: "attachment.upload.ready", ...ticket });
    await flushMicrotasks();
  });
  expect(putInit?.method).toBe("PUT");
  expect(putInit?.signal).toBeUndefined();
  expect(hook.result.current.controller.uploadBusy).toBe(true);
  await act(async () => {
    socket.close();
    window.dispatchEvent(new Event("focus"));
    await flushMicrotasks();
  });
  const reconnect = Socket.instances.at(-1)!;
  await act(async () => {
    reconnect.open();
    reconnect.message({
      type: "auth.ok",
      device: { id: "fixture-device", name: "Fixture" },
      capabilities: { outputJournal: 1 },
    });
    await flushMicrotasks();
  });
  expect(hook.result.current.app.status).toBe("online");
  expect(hook.result.current.controller.uploadBusy).toBe(true);
  await act(async () => {
    hook.result.current.controller.setDraft("A later independent text task");
    expect(hook.result.current.controller.send()).toBe(false);
    await flushMicrotasks();
  });
  expect(reconnect.sent.some((frame) => frame.type === "chat.send")).toBe(false);
  await act(async () => {
    rejectPut(new Error("Fixture releases stalled HTTP upload"));
    await flushMicrotasks();
  });
  expect(hook.result.current.controller.uploadBusy).toBe(false);
  console.log(
    "STALLED_UPLOAD",
    JSON.stringify({
      uploadBytes: image.size,
      hasAbortSignal: false,
      statusAfterReconnect: "online",
      sendingStillBlockedUntilPutSettles: true,
      serverTicketTtlMs: 300000,
    }),
  );
});

test("confirmed: offline project creation is never replayed and the first task is accepted in the prior fresh project", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "codeshell-review-20261012-web-round3-offline-create-"),
  );
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const projectA = join(directory, "project-a"),
    projectB = join(directory, "project-b");
  mkdirSync(projectA);
  mkdirSync(projectB);
  const roots = new Map([
    ["a", projectA],
    ["b", projectB],
  ]);
  const resolution = (id: string) => {
    const cwd = roots.get(id);
    if (!cwd) throw new Error("unknown project");
    return {
      cwd,
      trustCwd: cwd,
      projectId: id,
      mainRootId: `root-${id}`,
      projectPrimaryRootId: `root-${id}`,
      workspaceContext: createWorkspaceContext({
        projectId: id,
        projectRevision: 1,
        sessionMainRootId: `root-${id}`,
        roots: [{ id: `root-${id}`, path: cwd, role: "primary" }],
      }),
    };
  };
  const state: any = {};
  const replies: any[] = [];
  const runs: any[] = [];
  const listeners = new Set<(line: string) => void>();
  const bridge = {
    getLastRunContext: () => ({}),
    subscribeOutbound: (listener: (line: string) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    injectWorkerMessage: (line: string, meta: any) => {
      const prepared = prepareAgentRunMetadata(line, meta, {
        isProjectTrusted: () => true,
        lookupSession: () => undefined,
        resolveProjectRun: (id: string) => resolution(id),
        resolveExactRoot: (cwd: string) => {
          const id = [...roots].find(([, path]) => path === cwd)?.[0];
          return id ? resolution(id) : undefined;
        },
        isNoRepoCwd: () => false,
      });
      const request = JSON.parse(prepared.outLine);
      runs.push(request.params);
      queueMicrotask(() => {
        for (const listener of listeners)
          listener(
            JSON.stringify({ method: "agent/runAccepted", params: { requestId: request.id } }),
          );
      });
    },
  };
  let liveViewer = "viewer-before";
  const externalCommands = new MobileExternalRuntimeCommands({
    authenticated: (viewer, device) => viewer === liveViewer && device === "fixture-device",
    authority: async () => {
      throw new Error("new Session has no persisted authority");
    },
    owner: () => undefined,
    service: () => null,
    isExternal: () => false,
    exists: () => false,
    attachmentPath: async (path) => path,
  });
  const ctx: any = {
    remote: {
      sendToDevice: (_device: string, event: any) => replies.push(event),
      sendToViewer: (_viewer: string, event: any) => replies.push(event),
      broadcast: (event: any) => replies.push(event),
    },
    uploads: {
      claim() {
        throw new Error("unexpected image");
      },
      release: async () => {},
      finalize: async () => {},
    },
    externalCommands,
    getBridge: () => bridge,
    mobileSessionCwds: new Map(),
    mobilePermissionModes: new Map(),
    deviceState: () => state,
    ensureMobileSessionId: () => {
      throw new Error("expected prior real creation");
    },
    lookupDiskSessionCwd: async () => undefined,
    effectiveMobileRunCwd: () => state.selectedCwd,
    validateMobileSessionCwd: async (cwd: string) => [...roots.values()].includes(cwd),
    resolveMobileProjectRoot: (id: string, rootId?: string) => {
      const resolved = resolution(id);
      if (rootId && rootId !== resolved.mainRootId) throw new Error("wrong project root");
      return { projectId: id, rootId: resolved.mainRootId, cwd: resolved.cwd };
    },
    resolveSessionWorkspaceRoot: async (_id: string, fallback: string) => fallback,
    sendMobilePermissionMode() {},
    replayPendingMobileApprovals() {},
    broadcastMobileSession() {},
  };
  const { hook, socket } = await connect();
  await act(async () => {
    socket.message({
      type: "room.projects.ok",
      projects: [
        {
          id: "a",
          name: "Project A",
          path: projectA,
          primaryRootId: "root-a",
          roots: [{ id: "root-a", path: projectA, name: "A", role: "primary" }],
        },
        {
          id: "b",
          name: "Project B",
          path: projectB,
          primaryRootId: "root-b",
          roots: [{ id: "root-b", path: projectB, name: "B", role: "primary" }],
        },
      ],
    });
    await flushMicrotasks();
  });
  const sidebarActions = () =>
    (hook.result.current.controller.renderSidebar!({} as any) as any).props.app;
  await act(async () => {
    sidebarActions().newSession({ projectId: "a" });
    await flushMicrotasks();
  });
  const creationA = socket.sent.filter((frame) => frame.type === "session.create").at(-1);
  await handleClientEvent(ctx, { ...creationA, deviceId: "fixture-device", viewerId: liveViewer });
  const acceptedA = replies.find((frame) => frame.type === "chat.accepted");
  expect(acceptedA.sessionId).toBeString();
  await act(async () => {
    socket.message(acceptedA);
    await flushMicrotasks();
  });
  externalCommands.revoke(liveViewer, true);
  await act(async () => {
    socket.close();
    await flushMicrotasks();
  });
  await act(async () => {
    sidebarActions().newSession({ projectId: "b" });
    await flushMicrotasks();
  });
  await act(async () => {
    hook.result.current.controller.setDraft("Task intended for project B");
    await flushMicrotasks();
  });
  expect(socket.sent.filter((frame) => frame.type === "session.create")).toHaveLength(1);
  expect(hook.result.current.controller.workspaceCwd).toBe(projectB);
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await flushMicrotasks();
  });
  const reconnected = Socket.instances.at(-1)!;
  liveViewer = "viewer-after";
  await act(async () => {
    reconnected.open();
    reconnected.message({
      type: "auth.ok",
      device: { id: "fixture-device", name: "Fixture" },
      capabilities: { outputJournal: 1 },
    });
    await flushMicrotasks();
  });
  expect(hook.result.current.app.status).toBe("online");
  expect(reconnected.sent.filter((frame) => frame.type === "session.create")).toHaveLength(0);
  await act(async () => {
    expect(hook.result.current.controller.send()).toBe(true);
    await flushMicrotasks();
  });
  const chat = reconnected.sent.find((frame) => frame.type === "chat.send");
  expect(chat.sessionId).toBeUndefined();
  await handleClientEvent(ctx, { ...chat, deviceId: "fixture-device", viewerId: liveViewer });
  expect(runs).toHaveLength(1);
  expect(runs[0].sessionId).toBe(acceptedA.sessionId);
  expect(runs[0].cwd).toBe(projectA);
  expect(runs[0].projectId).toBe("a");
  const chatAck = replies.filter((frame) => frame.type === "chat.accepted").at(-1);
  expect(chatAck.clientMessageId).toBe(chat.clientMessageId);
  const workspaceBeforeAck = hook.result.current.controller.workspaceCwd;
  await act(async () => {
    reconnected.message(chatAck);
    await flushMicrotasks();
  });
  console.log(
    "OFFLINE_CREATE_WRONG_PROJECT",
    JSON.stringify({
      initialSession: acceptedA.sessionId,
      requestedProject: "b",
      uiWorkspaceBeforeSend: workspaceBeforeAck,
      creationFramesAfterReconnect: 0,
      workerAcceptedProject: runs[0].projectId,
      workerAcceptedCwd: runs[0].cwd,
      existingPersistedSession: false,
      realMetadataValidation: true,
    }),
  );
});

test("confirmed: local logout waits for a stalled HTTP logout request while the paired socket stays online", async () => {
  const { hook, socket } = await connect();
  let release!: (response: Response) => void;
  property(globalThis, "fetch", (async (url: any) => {
    expect(String(url)).toContain("/api/v1/auth/logout");
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  }) as typeof fetch);
  await act(async () => {
    hook.result.current.controller.logout?.();
    await flushMicrotasks();
  });
  expect(hook.result.current.app.status).toBe("online");
  expect(localStorage.getItem("cs.deviceId")).toBe("fixture-device");
  expect(socket.readyState).toBe(Socket.OPEN);
  await act(async () => {
    release(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await flushMicrotasks();
  });
  expect(hook.result.current.app.status).toBe("unpaired");
  expect(localStorage.getItem("cs.deviceId")).toBeNull();
  console.log(
    "STALLED_LOGOUT",
    JSON.stringify({
      localLogoutBeforeHttpResponse: false,
      socketBeforeHttpResponse: "OPEN",
      localLogoutAfterHttpResponse: true,
    }),
  );
});
