import { describe, expect, test } from "bun:test";
import {
  ChromeExtensionRuntimeService,
  type ChromeExtensionTransport,
} from "./chrome-extension-runtime.js";

describe("ChromeExtensionRuntimeService pairing", () => {
  test("requires a short-lived pairing code, pins a tab, and revokes on detach", async () => {
    let now = 1_000;
    const grantedSessions: string[] = [];
    const service = new ChromeExtensionRuntimeService({
      now: () => now,
      onGranted: (sessionId) => grantedSessions.push(sessionId),
    });
    const pending = service.beginPairing("session-1", "Research task");
    expect(pending.pairing?.code).toHaveLength(6);
    const list = (await service.handleExtensionMessage({ type: "pairing.list" })) as {
      requests: Array<{ code: string; label: string }>;
    };
    expect(list.requests).toEqual([
      { code: pending.pairing!.code, label: "Research task", expiresAt: 121_000 },
    ]);

    const accepted = (await service.handleExtensionMessage({
      type: "pairing.grant",
      code: pending.pairing!.code,
      tab: { id: 17, windowId: 3, url: "https://mail.example.test/", title: "Mail" },
    })) as ReturnType<ChromeExtensionRuntimeService["status"]>;
    expect(accepted.granted).toMatchObject({ tabId: 17, title: "Mail", expiresAt: 1_801_000 });
    expect(grantedSessions).toEqual(["session-1"]);

    await service.handleExtensionMessage({ type: "tab.detached", tabId: 17, reason: "canceled_by_user" });
    expect(service.status("session-1").granted).toBeUndefined();

    const expiring = service.beginPairing("session-2");
    now = expiring.pairing!.expiresAt;
    await expect(
      service.handleExtensionMessage({
        type: "pairing.grant",
        code: expiring.pairing!.code,
        tab: { id: 18, url: "https://example.test/", title: "Expired" },
      }),
    ).rejects.toThrow("expired");
  });

  test("rejects non-web pages and the same tab being granted to two tasks", async () => {
    const service = new ChromeExtensionRuntimeService();
    const first = service.beginPairing("session-1");
    await expect(
      service.handleExtensionMessage({
        type: "pairing.grant",
        code: first.pairing!.code,
        tab: { id: 1, url: "chrome://settings", title: "Settings" },
      }),
    ).rejects.toThrow("http(s)");

    const retry = service.beginPairing("session-1");
    await service.handleExtensionMessage({
      type: "pairing.grant",
      code: retry.pairing!.code,
      tab: { id: 1, url: "https://example.test", title: "One" },
    });
    const second = service.beginPairing("session-2");
    await expect(
      service.handleExtensionMessage({
        type: "pairing.grant",
        code: second.pairing!.code,
        tab: { id: 1, url: "https://example.test", title: "One" },
      }),
    ).rejects.toThrow("another CodeShell task");
  });

  test("dispatch exposes only the explicitly granted tab and forwards CDP navigation", async () => {
    const requests: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const transport: ChromeExtensionTransport = {
      start: async () => ({ listening: true, connected: true, statePath: "/tmp/state" }),
      stop: async () => undefined,
      status: () => ({ listening: true, connected: true, statePath: "/tmp/state" }),
      request: async (type, payload) => {
        requests.push({ type, payload });
        if (type === "tab.get") {
          return { id: 23, url: "https://example.test/", title: "Signed in" };
        }
        if (type === "cdp.command") return {};
        return {};
      },
    };
    const service = new ChromeExtensionRuntimeService({ server: transport });
    const pairing = service.beginPairing("session-1");
    await service.handleExtensionMessage({
      type: "pairing.grant",
      code: pairing.pairing!.code,
      tab: { id: 23, url: "https://example.test/", title: "Signed in" },
    });

    expect(JSON.parse((await service.dispatch("session-1", { action: "listTabs" }))!)).toEqual([
      {
        tabId: "23",
        url: "https://example.test/",
        title: "Signed in",
        active: true,
      },
    ]);
    expect(
      JSON.parse(
        (await service.dispatch("session-1", { action: "switchTab", tabId: "999" }))!,
      ),
    ).toMatchObject({ ok: false, code: "BLOCKED" });
    expect(
      JSON.parse(
        (await service.dispatch("session-1", {
          action: "navigate",
          url: "https://example.test/next",
        }))!,
      ),
    ).toMatchObject({ ok: true });
    expect(requests).toContainEqual({
      type: "cdp.command",
      payload: {
        tabId: 23,
        method: "Page.navigate",
        params: { url: "https://example.test/next" },
      },
    });
  });
});
