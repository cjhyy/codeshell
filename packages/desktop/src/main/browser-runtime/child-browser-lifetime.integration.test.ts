import { expect, test } from "bun:test";
import type { BrowserBridge } from "@cjhyy/code-shell-core";
import type { BrowserRuntimeLike } from "./runtime.js";
import {
  activateChildBrowserRuntime,
  dispatchInteractiveBrowserRuntimeAction,
  interactiveBrowserRuntimeOwner,
  releaseChildBrowserRuntime,
} from "./dispatch.js";
import { ChildBrowserWorkerLifetime } from "./child-browser-lifetime.js";

test("worker exit cancels pending child allocation while preserving parent and restarted child pages", async () => {
  const parent = "worker-lifetime-parent";
  const old = { sourceSessionId: "child", bindingId: "before-crash" };
  const resumed = { ...old, bindingId: "after-restart" };
  const lifetime = new ChildBrowserWorkerLifetime();
  const navigated: string[] = [];
  const closed: string[] = [];
  const live = new Set<string>();
  let finishAcquire!: () => void;
  const pendingAcquire = new Promise<void>((resolve) => {
    finishAcquire = resolve;
  });
  const runtime: BrowserRuntimeLike = {
    async acquire(options) {
      if (options.ownerId.endsWith(old.bindingId)) await pendingAcquire;
      live.add(options.ownerId);
      return {
        ...options,
        backendKind: "in-app",
        canReveal: true,
        bridge: {
          navigate: async () => {
            navigated.push(options.ownerId);
            return { ok: true };
          },
        } as BrowserBridge,
        show: async () => {},
        hide() {},
        release() {},
      };
    },
    close(owner) {
      closed.push(owner);
      live.delete(owner);
    },
    closeAll() {
      throw new Error("worker exit must not close the parent browser");
    },
  };
  const register = (child: typeof old) => {
    lifetime.register(JSON.stringify([parent, child.bindingId]), () =>
      releaseChildBrowserRuntime(parent, child, runtime),
    );
    activateChildBrowserRuntime(parent, child);
  };
  const navigate = (child?: typeof old) =>
    dispatchInteractiveBrowserRuntimeAction(
      parent,
      { action: "navigate", url: "https://example.test/" },
      runtime,
      child,
    ).then(JSON.parse);

  try {
    expect(await navigate()).toMatchObject({ ok: true });
    register(old);
    const oldAction = navigate(old);
    lifetime.close(); // AgentBridge onExit / onSpawnError
    lifetime.close(); // Duplicate process cleanup is harmless.
    expect(closed).toHaveLength(1);
    expect(await navigate(old)).toMatchObject({ ok: false, code: "TARGET_CLOSED" });

    register(resumed);
    expect(await navigate(resumed)).toMatchObject({ ok: true });
    finishAcquire();
    expect(await oldAction).toMatchObject({ ok: false, code: "TARGET_CLOSED" });
    expect(navigated).toHaveLength(2);
    expect(navigated[0]).toBe(interactiveBrowserRuntimeOwner(parent));
    expect(navigated[1]).toEndWith(resumed.bindingId);
    expect(live.has(interactiveBrowserRuntimeOwner(parent))).toBe(true);
    expect([...live].some((owner) => owner.endsWith(resumed.bindingId))).toBe(true);
    expect([...live].some((owner) => owner.endsWith(old.bindingId))).toBe(false);
    expect(closed.every((owner) => owner.endsWith(old.bindingId))).toBe(true);
  } finally {
    finishAcquire();
    lifetime.close();
  }
});
