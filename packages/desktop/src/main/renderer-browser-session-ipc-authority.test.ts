import { afterAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import type { RendererBrowserSessionAuthorization } from "./renderer-browser-session-access.js";

// The production resolver imports Core. Prove a private HOME and install a
// zero-origin guard before importing it; these IPC tests need no transport.
if (
  !process.env.HOME ||
  !process.env.CODE_SHELL_TEST_HOME ||
  realpathSync(process.env.HOME) !== process.env.HOME ||
  process.env.CODE_SHELL_TEST_HOME !== join(process.env.HOME, ".code-shell")
)
  throw new Error("Browser IPC fixtures require the guarded private HOME runner");
const originalFetch = globalThis.fetch;
const originalHttp = [http.request, http.get, https.request, https.get] as const;
const denyNetwork = () => {
  throw new Error("Browser IPC fixture refused a non-fixture origin");
};
globalThis.fetch = denyNetwork as typeof fetch;
http.request = http.get = https.request = https.get = denyNetwork;
syncBuiltinESMExports();
expect(() => fetch("https://browser-ipc.invalid/")).toThrow("non-fixture origin");
expect(() => http.get("http://127.0.0.1:1/")).toThrow("non-fixture origin");
afterAll(() => {
  globalThis.fetch = originalFetch;
  [http.request, http.get, https.request, https.get] = originalHttp;
  syncBuiltinESMExports();
});
const { createRendererBrowserSessionEventAccess } =
  await import("./renderer-browser-session-ipc-authority.js");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function fixture() {
  const frame = {};
  const state = { destroyed: false, deleting: false, current: true, prepareCalls: 0, checks: 0 };
  const event = {
    senderFrame: frame as object | null,
    sender: { id: 11, mainFrame: frame, isDestroyed: () => state.destroyed },
  };
  const authorization: RendererBrowserSessionAuthorization = {
    sessionId: "saved-session",
    bucket: "mounted-project::saved-session",
    assertCurrent: () => {
      state.checks++;
      if (!state.current) throw new Error("Session authority changed");
    },
  };
  const pending = deferred<RendererBrowserSessionAuthorization>();
  const access = createRendererBrowserSessionEventAccess(
    {
      prepare: async (sessionId, senderId) => {
        state.prepareCalls++;
        expect(sessionId).toBe("saved-session");
        expect(senderId).toBe(11);
        return pending.promise;
      },
    },
    (sessionId) => {
      expect(sessionId).toBe("saved-session");
      return state.deleting;
    },
  );
  return {
    state,
    event,
    authorization,
    pending,
    prepare: (sessionId: unknown = "saved-session") =>
      access(event as unknown as IpcMainInvokeEvent, sessionId),
  };
}

describe("createRendererBrowserSessionEventAccess", () => {
  test("preserves canonical authority and rechecks its guard on every dispatch", async () => {
    const f = fixture();
    const pending = f.prepare();
    f.pending.resolve(f.authorization);
    const authorization = await pending;
    expect(authorization.sessionId).toBe("saved-session");
    expect(authorization.bucket).toBe(f.authorization.bucket);
    expect(f.state.checks).toBe(1);
    authorization.assertCurrent();
    expect(f.state.checks).toBe(2);
  });

  test.each([null, {}])(
    "rejects a missing or non-main sender frame before preparing",
    async (frame) => {
      const f = fixture();
      f.event.senderFrame = frame;
      await expect(f.prepare()).rejects.toThrow("current Desktop main window");
      expect(f.state.prepareCalls).toBe(0);
    },
  );

  test("rejects invalid Session IDs before consulting authority", async () => {
    const f = fixture();
    await expect(f.prepare("../escape")).rejects.toThrow();
    expect(f.state.prepareCalls).toBe(0);
  });

  test("rejects a Session already being deleted before the disk read", async () => {
    const f = fixture();
    f.state.deleting = true;
    await expect(f.prepare()).rejects.toThrow("Session is being deleted");
    expect(f.state.prepareCalls).toBe(0);
  });

  const changes: [string, (f: ReturnType<typeof fixture>) => void][] = [
    ["renderer destruction", (f) => (f.state.destroyed = true)],
    ["main-frame replacement", (f) => (f.event.sender.mainFrame = {})],
    ["Session deletion", (f) => (f.state.deleting = true)],
    ["underlying authority revocation", (f) => (f.state.current = false)],
  ];
  test.each(changes)("rejects %s across the prepare await", async (_name, change) => {
    const f = fixture();
    const pending = f.prepare();
    change(f);
    f.pending.resolve(f.authorization);
    await expect(pending).rejects.toThrow();
  });

  test.each(changes)("rejects %s after grant creation", async (_name, change) => {
    const f = fixture();
    f.pending.resolve(f.authorization);
    const authorization = await f.prepare();
    change(f);
    expect(() => authorization.assertCurrent()).toThrow();
  });
});
