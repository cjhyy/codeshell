import { describe, expect, test } from "bun:test";
import type { BrowserBridge } from "@cjhyy/code-shell-core";
import { ExtensionBrowserSessions } from "./browser-sessions.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("extension grants around official Puppeteer connections", () => {
  test("a resume queued before takeover cannot restore control afterwards", async () => {
    const started = deferred<void>();
    const finish = deferred<{ ok: true }>();
    let connections = 0;
    const sessions = new ExtensionBrowserSessions(async () => {
      connections++;
      return {
        driver: {
          navigate: async () => {
            started.resolve();
            return finish.promise;
          },
          dispose() {},
        } as unknown as BrowserBridge & { dispose(): void },
        disconnect: async () => {},
      };
    });
    try {
      await sessions.grant(11, "grant", Date.now() + 30_000);
      const navigation = sessions.action(11, "grant", {
        action: "navigate",
        url: "https://example.test",
      });
      const navigationOutcome = Promise.allSettled([navigation]);
      await started.promise;
      const oldResume = sessions.action(11, "grant", { action: "resumeControl" });
      await sessions.action(11, "grant", { action: "requestTakeover" });
      finish.resolve({ ok: true });
      expect((await navigationOutcome)[0].status).toBe("rejected");
      expect(await oldResume).toMatchObject({ ok: false, code: "NEEDS_HUMAN" });
      expect(sessions.isPaused(11)).toBe(true);
      expect(connections).toBe(1);
      expect(await sessions.action(11, "grant", { action: "resumeControl" })).toMatchObject({
        ok: true,
      });
      expect(sessions.isPaused(11)).toBe(false);
      expect(connections).toBe(2);
    } finally {
      finish.resolve({ ok: true });
      await sessions.revokeAll();
    }
  });

  test("pins actions to a tab and grant and does not execute queued work after revoke", async () => {
    const started = deferred<void>();
    const finish = deferred<{ ok: true }>();
    const calls: number[] = [];
    const disconnected: number[] = [];
    const sessions = new ExtensionBrowserSessions(async (tabId) => ({
      driver: {
        navigate: async () => {
          calls.push(tabId);
          started.resolve();
          return finish.promise;
        },
        dispose: () => undefined,
      } as unknown as BrowserBridge & { dispose(): void },
      disconnect: async () => {
        disconnected.push(tabId);
      },
    }));
    try {
      await sessions.grant(11, "grant-one", Date.now() + 30_000);
      await sessions.grant(12, "grant-two", Date.now() + 30_000);
      await expect(
        sessions.action(12, "grant-one", { action: "navigate", url: "https://example.test" }),
      ).rejects.toThrow("does not match");
      const first = sessions.action(11, "grant-one", {
        action: "navigate",
        url: "https://example.test",
      });
      await started.promise;
      const queued = sessions.action(11, "grant-one", {
        action: "navigate",
        url: "https://example.test/queued",
      });
      const outcomes = Promise.allSettled([first, queued]);
      await sessions.revoke(11, "grant-one");
      finish.resolve({ ok: true });
      for (const outcome of await outcomes) {
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "rejected") expect(outcome.reason.message).toContain("revoked");
      }
      expect(calls).toEqual([11]);
      expect(disconnected).toEqual([11]);
      expect(sessions.has(12, "grant-two")).toBe(true);
    } finally {
      await sessions.revokeAll();
    }
  });

  test("handover interrupts, pauses without reattaching, and resumes with fresh references", async () => {
    const generations: string[] = [];
    const activeChecks: Array<() => boolean> = [];
    let disconnects = 0;
    const sessions = new ExtensionBrowserSessions(async (_tabId, namespace, isActive) => {
      generations.push(namespace);
      activeChecks.push(isActive);
      return {
        driver: {
          navigate: async () => ({ ok: true }),
          dispose: () => undefined,
        } as unknown as BrowserBridge & { dispose(): void },
        disconnect: async () => {
          disconnects += 1;
        },
      };
    });
    try {
      await sessions.grant(11, "grant-one", Date.now() + 30_000);
      expect(activeChecks[0]()).toBe(true);
      await sessions.action(11, "grant-one", { action: "requestTakeover" });
      expect(activeChecks[0]()).toBe(false);
      expect(disconnects).toBe(1);
      expect(
        await sessions.action(11, "grant-one", { action: "navigate", url: "https://example.test" }),
      ).toMatchObject({ ok: false, code: "NEEDS_HUMAN" });
      expect(generations).toEqual(["grant-one:1"]);
      expect(await sessions.action(11, "grant-one", { action: "resumeControl" })).toMatchObject({
        ok: true,
      });
      expect(generations).toEqual(["grant-one:1", "grant-one:3"]);
      expect(activeChecks[0]()).toBe(false);
      expect(activeChecks[1]()).toBe(true);
    } finally {
      await sessions.revokeAll();
    }
  });

  test("disconnect during attachment closes the newly resolved connection", async () => {
    const ready = deferred<void>();
    let disconnected = false;
    const sessions = new ExtensionBrowserSessions(async () => {
      await ready.promise;
      return {
        driver: { dispose: () => undefined } as unknown as BrowserBridge & { dispose(): void },
        disconnect: async () => {
          disconnected = true;
        },
      };
    });
    const attaching = sessions.grant(11, "grant-one", Date.now() + 30_000);
    await Promise.resolve();
    const revoked = sessions.revokeAll();
    ready.resolve();
    await expect(attaching).rejects.toThrow("ended while connecting");
    await revoked;
    expect(disconnected).toBe(true);
  });

  test("a replacement grant waits for the revoked attachment and its late detach", async () => {
    const attach = deferred<void>();
    const detach = deferred<void>();
    const events: string[] = [];
    const sessions = new ExtensionBrowserSessions(async (_tabId, namespace) => {
      events.push(`attach:${namespace}`);
      if (namespace === "old-grant:1") await attach.promise;
      return {
        driver: { dispose: () => undefined } as unknown as BrowserBridge & { dispose(): void },
        disconnect: async () => {
          events.push(`detach:${namespace}`);
          if (namespace === "old-grant:1") await detach.promise;
        },
      };
    });
    try {
      const first = sessions.grant(11, "old-grant", Date.now() + 30_000);
      const firstOutcome = Promise.allSettled([first]);
      await Promise.resolve();
      const revoke = sessions.revoke(11, "old-grant");
      const replacement = sessions.grant(11, "new-grant", Date.now() + 30_000);
      await Promise.resolve();
      expect(events).toEqual(["attach:old-grant:1"]);
      attach.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events).toEqual(["attach:old-grant:1", "detach:old-grant:1"]);
      detach.resolve();
      await Promise.all([revoke, replacement]);
      expect((await firstOutcome)[0].status).toBe("rejected");
      expect(events).toEqual(["attach:old-grant:1", "detach:old-grant:1", "attach:new-grant:1"]);
      expect(sessions.has(11, "new-grant")).toBe(true);
    } finally {
      attach.resolve();
      detach.resolve();
      await sessions.revokeAll();
    }
  });

  test("an immediate resume waits until handover has actually released the debugger", async () => {
    const detach = deferred<void>();
    const attached: string[] = [];
    const sessions = new ExtensionBrowserSessions(async (_tabId, namespace) => {
      attached.push(namespace);
      return {
        driver: { dispose: () => undefined } as unknown as BrowserBridge & { dispose(): void },
        disconnect: async () => {
          if (attached.length === 1) await detach.promise;
        },
      };
    });
    try {
      await sessions.grant(11, "grant", Date.now() + 30_000);
      const handover = sessions.action(11, "grant", { action: "requestTakeover" });
      const resumed = sessions.action(11, "grant", { action: "resumeControl" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(attached).toEqual(["grant:1"]);
      detach.resolve();
      await Promise.all([handover, resumed]);
      expect(attached).toEqual(["grant:1", "grant:3"]);
    } finally {
      detach.resolve();
      await sessions.revokeAll();
    }
  });

  test("attachment timeout fails closed and keeps late cleanup ahead of any new grant", async () => {
    const attach = deferred<void>();
    const detached: string[] = [];
    const attached: string[] = [];
    const sessions = new ExtensionBrowserSessions(
      async (_tabId, namespace) => {
        attached.push(namespace);
        if (namespace === "old-grant:1") await attach.promise;
        return {
          driver: { dispose: () => undefined } as unknown as BrowserBridge & { dispose(): void },
          disconnect: async () => {
            detached.push(namespace);
          },
        };
      },
      Date.now,
      10,
    );
    try {
      await expect(sessions.grant(11, "old-grant", Date.now() + 30_000)).rejects.toThrow(
        "timed out",
      );
      expect(sessions.has(11)).toBe(false);
      await expect(sessions.grant(11, "waiting-grant", Date.now() + 30_000)).rejects.toThrow(
        "timed out",
      );
      expect(attached).toEqual(["old-grant:1"]);
      attach.resolve();
      await sessions.grant(11, "final-grant", Date.now() + 30_000);
      expect(detached).toEqual(["old-grant:1"]);
      expect(attached).toEqual(["old-grant:1", "final-grant:1"]);
    } finally {
      attach.resolve();
      await sessions.revokeAll();
    }
  });
});
