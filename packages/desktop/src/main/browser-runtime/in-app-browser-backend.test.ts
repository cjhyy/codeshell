import { describe, expect, test } from "bun:test";
import type { BrowserBridge } from "@cjhyy/code-shell-core";
import { forgetSession, registerSessionBucket } from "../browser-driver/active-guest.js";
import { InAppBrowserBackend } from "./in-app-browser-backend.js";

function bridge(): BrowserBridge {
  return {
    snapshot: async () => ({ url: "about:blank", elements: [] }),
    click: async () => ({ ok: true }),
    type: async () => ({ ok: true }),
    navigate: async () => ({ ok: true }),
    scroll: async () => ({ ok: true }),
    readContent: async () => ({ ok: true, url: "about:blank", text: "" }),
    extractLinks: async () => ({
      ok: true,
      url: "about:blank",
      links: [],
      images: [],
      videos: [],
    }),
    waitForLoad: async () => ({ ok: true }),
    hover: async () => ({ ok: true }),
    selectOption: async () => ({ ok: true }),
    pressKey: async () => ({ ok: true }),
    fetchImages: async () => [],
    screenshot: async () => ({ ok: true }),
    listTabs: async () => [],
    switchTab: async () => ({ ok: true }),
  };
}

describe("InAppBrowserBackend", () => {
  test("resolves the exact partition registered for the task session", async () => {
    const sessionId = "in-app-backend-test-session";
    const partitions: string[] = [];
    registerSessionBucket(sessionId, "project::in-app-backend-test-session");
    try {
      const backend = new InAppBrowserBackend({
        targetPool: {
          acquire: ({ partition }) => {
            partitions.push(partition);
            return {
              bridge: bridge(),
              show: async () => undefined,
              hide: () => undefined,
              release: () => undefined,
            };
          },
          close: () => undefined,
          closeAll: () => undefined,
        },
      });

      await backend.acquire({ ownerId: `interactive:${sessionId}`, profileId: sessionId });
      expect(partitions).toEqual(["persist:browser:project::in-app-backend-test-session"]);
    } finally {
      forgetSession(sessionId);
    }
  });

  test("uses the task BrowserPanel partition and reveals the exact target", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let shown = 0;
    let hidden = 0;
    let released = 0;
    const backend = new InAppBrowserBackend({
      partitionForProfile: (profileId) =>
        profileId === "session-1" ? "persist:browser:project::session-1" : null,
      targetPool: {
        acquire: (options) => {
          calls.push(options);
          return {
            bridge: bridge(),
            show: async () => {
              shown += 1;
            },
            hide: () => {
              hidden += 1;
            },
            release: () => {
              released += 1;
            },
          };
        },
        close: (ownerId) => calls.push({ close: ownerId }),
        closeAll: () => calls.push({ closeAll: true }),
      },
    });

    const lease = await backend.acquire({
      ownerId: "interactive:session-1",
      profileId: "session-1",
      initialUrl: "https://example.test/",
      title: "Task browser",
    });

    expect(calls).toEqual([
      {
        ownerId: "interactive:session-1",
        partition: "persist:browser:project::session-1",
        initialUrl: "https://example.test/",
        title: "Task browser",
      },
    ]);
    expect(lease.kind).toBe("in-app");
    expect(lease.canReveal).toBe(true);
    await lease.show();
    lease.hide();
    lease.release();
    expect({ shown, hidden, released }).toEqual({ shown: 1, hidden: 1, released: 1 });
  });

  test("does not acquire when the task has no in-app profile", async () => {
    const backend = new InAppBrowserBackend({
      partitionForProfile: () => null,
      targetPool: {
        acquire: () => {
          throw new Error("must not acquire");
        },
        close: () => undefined,
        closeAll: () => undefined,
      },
    });

    await expect(
      backend.acquire({ ownerId: "interactive:missing", profileId: "missing" }),
    ).rejects.toThrow("no in-app browser profile");
  });
});
