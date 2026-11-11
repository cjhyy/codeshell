import { expect, test } from "bun:test";
import {
  createDesktopModuleRegistry,
  createDesktopShutdownHandler,
  desktopShutdownFailureDialog,
  desktopShutdownDialogChoice,
} from "./desktop-shutdown.js";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("modules start synchronously once and quit awaits reverse-order cleanup at the host boundary", async () => {
  const calls: string[] = [];
  let finishSecond!: () => void;
  const secondCleanup = new Promise<void>((resolve) => {
    finishSecond = resolve;
  });
  const modules = createDesktopModuleRegistry([
    {
      name: "first",
      start: () => {
        calls.push("start-first");
      },
      dispose: () => {
        calls.push("dispose-first");
      },
    },
    {
      name: "second",
      start: () => {
        calls.push("start-second");
      },
      dispose: async () => {
        calls.push("dispose-second");
        await secondCleanup;
      },
    },
  ]);
  modules.start();
  modules.start();
  expect(calls).toEqual(["start-first", "start-second"]);
  const handler = createDesktopShutdownHandler({
    ownsInstance: () => true,
    flushRenderers: async () => {
      calls.push("save");
    },
    disposeOperationResolution: async () => {
      calls.push("operations");
    },
    cleanup: async () => {
      calls.push("cleanup-before-modules");
      const pending = modules.dispose();
      expect(modules.dispose()).toBe(pending);
      await pending;
      calls.push("cleanup-after-modules");
    },
    finalize: async () => {
      calls.push("finalize");
    },
    quit: () => calls.push("quit"),
    onError: () => {
      throw new Error("Unexpected module cleanup failure");
    },
  });
  handler({ preventDefault() {} });
  await settle();
  expect(calls.slice(2)).toEqual([
    "save",
    "operations",
    "cleanup-before-modules",
    "dispose-second",
  ]);
  finishSecond();
  await settle();
  expect(calls.slice(-4)).toEqual(["dispose-first", "cleanup-after-modules", "finalize", "quit"]);
  expect(() => modules.start()).toThrow("disposed");
});

test("a partially started module is cleaned and failures do not skip earlier owners", async () => {
  const calls: string[] = [];
  const startError = new Error("start failed");
  const cleanupError = new Error("cleanup failed");
  const modules = createDesktopModuleRegistry([
    {
      name: "first",
      start() {},
      dispose: () => {
        calls.push("first");
      },
    },
    {
      name: "partial",
      start() {
        throw startError;
      },
      dispose() {
        calls.push("partial");
        throw cleanupError;
      },
    },
    {
      name: "unstarted",
      start: () => {
        calls.push("unexpected-start");
      },
      dispose: () => {
        calls.push("unexpected-dispose");
      },
    },
  ]);
  expect(() => modules.start()).toThrow(startError);
  expect(() => modules.start()).toThrow(startError);
  const pending = modules.dispose();
  await expect(pending).rejects.toMatchObject({ errors: [cleanupError] });
  expect(modules.dispose()).toBe(pending);
  expect(calls).toEqual(["partial", "first"]);
});

test("unstarted modules acquire no resources and duplicate registration is rejected", async () => {
  const module = {
    name: "fixture",
    start() {
      throw new Error("Unexpected start");
    },
    dispose() {
      throw new Error("Unexpected disposal");
    },
  };
  expect(() => createDesktopModuleRegistry([module, module])).toThrow("unique");
  const modules = createDesktopModuleRegistry([module]);
  await modules.dispose();
  expect(() => modules.start()).toThrow("disposed");
});

test("external runtime registration stays lazy and owns one service subscription until shutdown", async () => {
  const { createExternalRuntimeModule } = await import("./external-runtime-module.js");
  const calls: string[] = [];
  const external = createExternalRuntimeModule(() => {
    calls.push("options");
    return {
      approvals: { windows: () => [] },
      service: {
        featureFlags: () => ({ external_agent_runtime: true }),
        registerSession() {},
        releaseSession() {},
        resolveProjectBinding: () => undefined,
        emit() {},
        backgroundWork: {
          subscribe: () => {
            calls.push("subscribe");
            return () => {
              calls.push("unsubscribe");
            };
          },
          claimResults: () => undefined,
          hasPending: () => false,
          hasRunning: () => false,
          dropSession() {},
        },
      },
    };
  });
  const modules = createDesktopModuleRegistry([external]);
  expect(calls).toEqual([]);
  expect(external.service).toBeNull();
  expect(external.approvals).toBeNull();
  modules.start();
  const service = external.service;
  expect(service?.isEnabled()).toBe(true);
  expect(external.approvals).not.toBeNull();
  modules.start();
  expect(external.service).toBe(service);
  expect(calls).toEqual(["options", "subscribe"]);
  const pending = modules.dispose();
  expect(external.service).toBeNull();
  await pending;
  expect(calls).toEqual(["options", "subscribe", "unsubscribe"]);
});

test("approval listeners subscribed before the module starts hear its router, and stop when removed", async () => {
  const { createExternalRuntimeModule } = await import("./external-runtime-module.js");
  const sent: unknown[] = [];
  const window = {
    isDestroyed: () => false,
    webContents: { id: 1, send: (_channel: string, payload: unknown) => void sent.push(payload) },
  };
  const mobile: string[] = [];
  const external = createExternalRuntimeModule(() => ({
    approvals: {
      windows: () => [window] as never,
      onPendingChange: (event) => void mobile.push(event.type),
    },
    service: {
      featureFlags: () => ({}),
      registerSession() {},
      releaseSession() {},
      resolveProjectBinding: () => undefined,
      emit() {},
    },
  }));
  const early: string[] = [];
  const late: string[] = [];
  const unsubscribeEarly = external.subscribeApprovals((event) => {
    early.push(event.type);
    throw new Error("listener bug");
  });
  const modules = createDesktopModuleRegistry([external]);
  modules.start();
  const unsubscribeLate = external.subscribeApprovals((event) => void late.push(event.type));
  const decision = external.approvals!.request("s1", { toolName: "Bash" });
  const { requestId } = sent[0] as { requestId: string };
  expect(external.approvals!.settle(requestId, { approved: true })).toBe(true);
  await expect(decision).resolves.toEqual({ approved: true });
  expect(early).toEqual(["requested", "resolved"]);
  expect(late).toEqual(["requested", "resolved"]);
  expect(mobile).toEqual(["requested", "resolved"]);
  unsubscribeEarly();
  unsubscribeLate();
  void external.approvals!.request("s1", { toolName: "Bash" });
  expect(early).toHaveLength(2);
  expect(late).toHaveLength(2);
  expect(mobile).toHaveLength(3);
  external.approvals!.cancelSession("s1");
  await modules.dispose();
});

test("the external runtime pilot retains first-window start and the existing shutdown position", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const startup = source.slice(source.indexOf("  if (!bridge) {"));
  expect(source.match(/desktopModules\.start\(\)/g)).toHaveLength(1);
  expect(startup.indexOf("bridge = new AgentBridge(")).toBeLessThan(
    startup.indexOf("desktopModules.start();"),
  );
  expect(startup.indexOf("desktopModules.start();")).toBeLessThan(
    startup.indexOf("const externalGoalSessions"),
  );
  expect(source).not.toContain("await desktopModules.start()");
  const cleanup = source.slice(source.indexOf("registerDesktopShutdown(app,"));
  expect(cleanup.match(/desktopModules\.dispose\(\)/g)).toHaveLength(1);
  expect(cleanup.indexOf("roomManager.closeAll();")).toBeLessThan(
    cleanup.indexOf("desktopModules.dispose()"),
  );
  expect(cleanup.indexOf("desktopModules.dispose()")).toBeLessThan(
    cleanup.indexOf("getCuaDriverHost()?.stop()"),
  );
});

test("quit waits for saves and actual child cleanup, coalesces retries and permits final quit", async () => {
  const calls: string[] = [];
  let release: () => void = () => {};
  const childCleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  const event = { preventDefault: () => calls.push("block") };
  const handler = createDesktopShutdownHandler({
    ownsInstance: () => true,
    flushRenderers: async () => {
      calls.push("save");
    },
    disposeOperationResolution: async () => {
      calls.push("children");
      await childCleanup;
    },
    cleanup: async () => {
      calls.push("cleanup");
    },
    quit: () => {
      calls.push("quit");
      handler(event);
    },
    onError: () => {
      throw new Error("unexpected failure");
    },
  });
  handler(event);
  handler(event);
  await settle();
  expect(calls).toEqual(["block", "block", "save", "children"]);
  release();
  await settle();
  expect(calls).toEqual(["block", "block", "save", "children", "cleanup", "quit"]);
});

for (const failing of ["save"] as const) {
  test(`failed ${failing} prevents quit and allows an explicit retry`, async () => {
    const calls: string[] = [];
    let fail = true;
    const run = (name: string) => async () => {
      calls.push(name);
      if (name === failing && fail) throw new Error("unproven");
    };
    const handler = createDesktopShutdownHandler({
      ownsInstance: () => true,
      flushRenderers: run("save"),
      disposeOperationResolution: run("children"),
      cleanup: run("cleanup"),
      quit: () => calls.push("quit"),
      onError: (phase) => calls.push(phase),
    });
    const event = { preventDefault() {} };
    handler(event);
    await settle();
    expect(calls).not.toContain("quit");
    if (failing !== "cleanup") expect(calls).not.toContain("cleanup");
    if (failing === "save") expect(calls).not.toContain("children");
    fail = false;
    handler(event);
    await settle();
    expect(calls.slice(-4)).toEqual(["save", "children", "cleanup", "quit"]);
  });
}

test("synchronous adapter failure is retryable and a secondary instance does not block quit", async () => {
  let owned = false,
    attempts = 0,
    quits = 0,
    blocks = 0;
  const handler = createDesktopShutdownHandler({
    ownsInstance: () => owned,
    flushRenderers: () => {
      if (++attempts === 1) throw new Error("sync failure");
      return Promise.resolve();
    },
    disposeOperationResolution: async () => {},
    cleanup: async () => {},
    quit: () => {
      quits++;
    },
    onError: () => {},
  });
  const event = {
    preventDefault: () => {
      blocks++;
    },
  };
  handler(event);
  expect(blocks).toBe(0);
  expect(attempts).toBe(0);
  owned = true;
  handler(event);
  await settle();
  handler(event);
  await settle();
  expect(attempts).toBe(2);
  expect(quits).toBe(1);
});

test("user can retry a failed save or continue cleanup before forcing quit", async () => {
  const calls: string[] = [];
  let saves = 0;
  const handler = createDesktopShutdownHandler({
    ownsInstance: () => true,
    flushRenderers: async () => {
      calls.push("save");
      if (++saves === 1) throw Error("fixture");
    },
    disposeOperationResolution: async () => {
      calls.push("children");
      throw Error("fixture");
    },
    cleanup: async () => {
      calls.push("cleanup");
    },
    quit: () => {
      calls.push("quit");
    },
    onError: () => {},
    resolveFailure: async (phase) => (phase === "session.quit_save_failed" ? "retry" : "quit"),
  });
  handler({ preventDefault() {} });
  await settle();
  expect(calls).toEqual(["save", "save", "children", "cleanup", "quit"]);
});

test("cancel after an early save failure retains every service and cancels pending update installation", async () => {
  const calls: string[] = [];
  let fails = true;
  const handler = createDesktopShutdownHandler({
    ownsInstance: () => true,
    flushRenderers: async () => {
      calls.push("save");
      if (fails) throw Error("save failed");
    },
    disposeOperationResolution: async () => {
      calls.push("children");
    },
    cleanup: async () => {
      calls.push("cleanup");
    },
    finalize: async () => {
      calls.push("cache-close");
    },
    quit: () => {
      calls.push("quit");
    },
    cancelQuit: () => {
      calls.push("cancel-update");
    },
    onError() {},
    resolveFailure: async (_phase, _error, { canCancel }) => {
      expect(canCancel).toBe(true);
      return "cancel";
    },
  });
  handler({ preventDefault() {} });
  await settle();
  expect(calls).toEqual(["save", "cancel-update"]);
  fails = false;
  handler({ preventDefault() {} });
  await settle();
  expect(calls).toEqual([
    "save",
    "cancel-update",
    "save",
    "children",
    "cleanup",
    "cache-close",
    "quit",
  ]);
});

for (const failing of ["children", "cleanup", "cache-close"] as const)
  test(`partial ${failing} failure cannot resume the app even when a stale dialog returns cancel`, async () => {
    const calls: string[] = [];
    const action = (name: string) => async () => {
      calls.push(name);
      if (name === failing) throw Error("resource already partly disposed");
    };
    const handler = createDesktopShutdownHandler({
      ownsInstance: () => true,
      flushRenderers: action("save"),
      disposeOperationResolution: action("children"),
      cleanup: action("cleanup"),
      finalize: action("cache-close"),
      quit: () => {
        calls.push("quit");
      },
      cancelQuit: () => {
        calls.push("cancel-update");
      },
      onError() {},
      resolveFailure: async (_phase, _error, { canCancel }) => {
        expect(canCancel).toBe(false);
        return "cancel";
      },
    });
    handler({ preventDefault() {} });
    await settle();
    expect(calls).toEqual(["save", "children", "cleanup", "cache-close", "quit"]);
    handler({
      preventDefault() {
        throw Error("final quit must be allowed");
      },
    });
  });

test("upload cleanup retry happens while persistence is open and final close runs only after it settles", async () => {
  const calls: string[] = [];
  let uploads = 0,
    servicesDisposed = false,
    cacheClosed = false;
  const handler = createDesktopShutdownHandler({
    ownsInstance: () => true,
    flushRenderers: async () => {
      calls.push("save");
    },
    disposeOperationResolution: async () => {
      servicesDisposed = true;
    },
    cleanup: async () => {
      expect(servicesDisposed).toBe(true);
      expect(cacheClosed).toBe(false);
      calls.push("uploads");
      if (++uploads === 1) throw Error("upload spool cleanup failed");
    },
    finalize: async () => {
      expect(uploads).toBe(2);
      cacheClosed = true;
      calls.push("cache-close");
    },
    quit: () => {
      expect(cacheClosed).toBe(true);
      calls.push("quit");
    },
    onError() {},
    resolveFailure: async (_phase, _error, { canCancel }) => {
      expect(canCancel).toBe(false);
      return "retry";
    },
  });
  handler({ preventDefault() {} });
  await settle();
  expect(calls).toEqual(["save", "uploads", "uploads", "cache-close", "quit"]);
});

for (const early of [true, false])
  test(`a rejected failure dialog ${early ? "cancels before disposal" : "finishes irreversible exit"}`, async () => {
    const calls: string[] = [];
    const handler = createDesktopShutdownHandler({
      ownsInstance: () => true,
      flushRenderers: async () => {
        if (early) throw Error("save failed");
      },
      disposeOperationResolution: async () => {
        calls.push("dispose");
        throw Error("partly disposed");
      },
      cleanup: async () => {
        calls.push("cleanup");
      },
      finalize: async () => {
        calls.push("cache-close");
      },
      quit: () => {
        calls.push("quit");
      },
      cancelQuit: () => {
        calls.push("cancel-update");
      },
      onError() {},
      resolveFailure: async () => {
        throw Error("dialog unavailable");
      },
    });
    handler({ preventDefault() {} });
    await settle();
    expect(calls).toEqual(
      early ? ["cancel-update"] : ["dispose", "cleanup", "cache-close", "quit"],
    );
  });

test("shutdown failure UI only offers cancellation before disposal", () => {
  expect(desktopShutdownFailureDialog(true).buttons).toContain("取消退出");
  expect(desktopShutdownDialogChoice(1, true)).toBe("cancel");
  expect(desktopShutdownFailureDialog(false).buttons).toEqual(["重试", "仍然退出"]);
  for (const response of [-1, 0, 1, 2])
    expect(desktopShutdownDialogChoice(response, false)).not.toBe("cancel");
});

test("native quit wiring uses phase-aware dialogs without restoring disposed services", async () => {
  const { registerDesktopShutdown } = await import("./desktop-shutdown.js");
  const listeners = new Map<string, (...args: any[]) => void>();
  const calls: string[] = [];
  let owned = true;
  const app = {
    on: (event: string, callback: (...args: any[]) => void) => listeners.set(event, callback),
    quit: () => {
      calls.push("quit");
    },
  };
  registerDesktopShutdown(app, {
    ownsInstance: () => owned,
    platform: "linux",
    flushRenderers: async () => {},
    disposeOperationResolution: async () => {},
    cleanup: async () => {
      calls.push("disposed");
      throw Error("cleanup failed");
    },
    finalize: async () => {
      calls.push("cache-close");
    },
    onError() {},
    showFailureDialog: async (options) => {
      expect(options.buttons).toEqual(["重试", "仍然退出"]);
      return { response: 1 };
    },
    restoreMainWindow: async () => {
      calls.push("restore");
    },
  });
  listeners.get("before-quit")!({ preventDefault() {} });
  await settle();
  expect(calls).toEqual(["disposed", "cache-close", "quit"]);
  listeners.get("activate")!();
  expect(calls).not.toContain("restore");
  listeners.get("window-all-closed")!();
  expect(calls.at(-1)).toBe("quit");
  owned = false;
  listeners.get("activate")!();
  expect(calls).not.toContain("restore");
});
