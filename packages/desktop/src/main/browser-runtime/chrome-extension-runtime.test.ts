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
    await service.handleExtensionMessage({ type: "hello", protocolVersion: 2 });
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
      grantId: "grant-session-1-0001",
      code: pending.pairing!.code,
      tab: { id: 17, windowId: 3, url: "https://mail.example.test/", title: "Mail" },
    })) as ReturnType<ChromeExtensionRuntimeService["status"]>;
    expect(accepted.granted).toMatchObject({ tabId: 17, title: "Mail", expiresAt: 1_801_000 });
    expect(grantedSessions).toEqual(["session-1"]);

    await service.handleExtensionMessage({
      type: "tab.detached",
      tabId: 17,
      grantId: "grant-session-1-0001",
      reason: "canceled_by_user",
    });
    expect(service.status("session-1").granted).toBeUndefined();

    const expiring = service.beginPairing("session-2");
    now = expiring.pairing!.expiresAt;
    await expect(
      service.handleExtensionMessage({
        type: "pairing.grant",
        grantId: "grant-session-2-0001",
        code: expiring.pairing!.code,
        tab: { id: 18, url: "https://example.test/", title: "Expired" },
      }),
    ).rejects.toThrow("expired");
  });

  test("rejects non-web pages and the same tab being granted to two tasks", async () => {
    const service = new ChromeExtensionRuntimeService();
    await service.handleExtensionMessage({ type: "hello", protocolVersion: 2 });
    const first = service.beginPairing("session-1");
    await expect(
      service.handleExtensionMessage({
        type: "pairing.grant",
        grantId: "grant-session-1-0001",
        code: first.pairing!.code,
        tab: { id: 1, url: "chrome://settings", title: "Settings" },
      }),
    ).rejects.toThrow("http(s)");

    const retry = service.beginPairing("session-1");
    await service.handleExtensionMessage({
      type: "pairing.grant",
      grantId: "grant-session-1-0001",
      code: retry.pairing!.code,
      tab: { id: 1, url: "https://example.test", title: "One" },
    });
    const second = service.beginPairing("session-2");
    await expect(
      service.handleExtensionMessage({
        type: "pairing.grant",
        grantId: "grant-session-2-0001",
        code: second.pairing!.code,
        tab: { id: 1, url: "https://example.test", title: "One" },
      }),
    ).rejects.toThrow("another CodeShell task");
  });

  test("dispatch exposes only the explicitly granted tab and forwards high-level navigation", async () => {
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
        if (type === "browser.action") return { ok: true };
        return {};
      },
    };
    const service = new ChromeExtensionRuntimeService({ server: transport });
    await service.handleExtensionMessage({ type: "hello", protocolVersion: 2 });
    const pairing = service.beginPairing("session-1");
    await service.handleExtensionMessage({
      type: "pairing.grant",
      grantId: "grant-session-1-0001",
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
      JSON.parse((await service.dispatch("session-1", { action: "switchTab", tabId: "999" }))!),
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
      type: "browser.action",
      payload: {
        tabId: 23,
        grantId: "grant-session-1-0001",
        request: { action: "navigate", url: "https://example.test/next" },
      },
    });
    expect(requests.some((request) => request.type === "cdp.command")).toBe(false);
  });

  test("keeps an incompatible hello error visible on later pairing requests until reloaded", async () => {
    const service = new ChromeExtensionRuntimeService();
    const pairing = service.beginPairing("session-1");
    const grant = {
      type: "pairing.grant",
      grantId: "grant-session-1-0001",
      code: pairing.pairing!.code,
      tab: { id: 1, url: "https://example.test", title: "One" },
    };
    await expect(service.handleExtensionMessage(grant)).rejects.toThrow("reload");
    // The legacy hello is fire-and-forget: rejecting it alone cannot show an error in its popup.
    for (const protocolVersion of [undefined, 1]) {
      await expect(
        service.handleExtensionMessage({ type: "hello", protocolVersion }),
      ).rejects.toThrow("0.2.0");
      await expect(service.handleExtensionMessage({ type: "pairing.list" })).rejects.toThrow(
        "reload",
      );
      await expect(service.handleExtensionMessage(grant)).rejects.toThrow("reload");
      expect(service.status("session-1")).toMatchObject({
        connected: false,
        error: expect.stringContaining("chrome://extensions"),
      });
    }
    await service.handleExtensionMessage({ type: "hello", protocolVersion: 2 });
    expect(service.status("session-1").error).toBeUndefined();
    await expect(service.handleExtensionMessage(grant)).resolves.toMatchObject({
      granted: { tabId: 1 },
    });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function runtimeFixture(request: ChromeExtensionTransport["request"], now = () => 1_000) {
  let connected = true;
  const service = new ChromeExtensionRuntimeService({
    now,
    server: {
      start: async () => ({ listening: true, connected, statePath: "/tmp/test" }),
      stop: async () => {
        connected = false;
      },
      status: () => ({ listening: true, connected, statePath: "/tmp/test" }),
      request,
    },
  });
  await service.handleExtensionMessage({ type: "hello", protocolVersion: 2 });
  const pairing = service.beginPairing("session-1");
  await service.handleExtensionMessage({
    type: "pairing.grant",
    code: pairing.pairing!.code,
    grantId: "grant-session-1-0001",
    tab: { id: 23, url: "https://example.test", title: "Authorized" },
  });
  return {
    service,
    disconnect: () => {
      connected = false;
    },
  };
}

describe("Chrome high-level grant isolation", () => {
  test("takeover cancels queued resume and a click waiting for its tab check", async () => {
    const started = deferred<void>();
    const finish = deferred<unknown>();
    const actions: string[] = [];
    const { service } = await runtimeFixture(async (type, payload) => {
      if (type === "tab.get") {
        started.resolve();
        return finish.promise;
      }
      if (type === "browser.action") {
        actions.push((payload?.request as { action: string }).action);
      }
      return { ok: true };
    });
    const click = service.dispatch("session-1", { action: "click", ref: "e1" });
    await started.promise;
    const oldResume = service.dispatch("session-1", { action: "resumeControl" });
    expect(
      JSON.parse((await service.dispatch("session-1", { action: "requestTakeover" }))!),
    ).toMatchObject({ ok: true });
    finish.resolve({ id: 23, url: "https://example.test", title: "Authorized" });
    expect(JSON.parse((await click)!)).toMatchObject({ ok: false });
    expect(JSON.parse((await oldResume)!)).toMatchObject({ ok: false, code: "NEEDS_HUMAN" });
    expect(actions).toEqual(["requestTakeover"]);
    expect(
      JSON.parse((await service.dispatch("session-1", { action: "resumeControl" }))!),
    ).toMatchObject({ ok: true });
    expect(actions).toEqual(["requestTakeover", "resumeControl"]);
  });

  for (const end of ["revoke", "expire", "disconnect", "reconnect"] as const) {
    test(`does not execute queued actions after ${end}`, async () => {
      let now = 1_000;
      const started = deferred<void>();
      const finish = deferred<unknown>();
      let actions = 0;
      const { service, disconnect } = await runtimeFixture(
        async (type) => {
          if (type !== "browser.action") return {};
          actions += 1;
          started.resolve();
          return finish.promise;
        },
        () => now,
      );
      const first = service.dispatch("session-1", {
        action: "navigate",
        url: "https://example.test/first",
      });
      await started.promise;
      const queued = service.dispatch("session-1", {
        action: "navigate",
        url: "https://example.test/second",
      });
      if (end === "revoke") service.revoke("session-1");
      if (end === "expire") now += 30 * 60 * 1000;
      if (end === "disconnect") disconnect();
      if (end === "reconnect")
        await service.handleExtensionMessage({ type: "hello", protocolVersion: 2 });
      finish.resolve({ ok: true });
      expect(JSON.parse((await first)!)).toMatchObject({ ok: false });
      expect(JSON.parse((await queued)!)).toMatchObject({ ok: false, code: "NEEDS_HUMAN" });
      expect(actions).toBe(1);
      expect(
        JSON.parse((await service.dispatch("session-1", { action: "snapshot" }))!),
      ).toMatchObject({ ok: false, code: "NEEDS_HUMAN" });
      service.forgetSession("session-1");
      expect(await service.dispatch("session-1", { action: "snapshot" })).toBeUndefined();
    });
  }

  test("does not act on a mismatched tab response or detached event from an old grant", async () => {
    let actions = 0;
    const { service } = await runtimeFixture(async (type) => {
      if (type === "tab.get") return { id: 999, url: "https://example.test", title: "Other task" };
      if (type === "browser.action") actions += 1;
      return {};
    });
    await service.handleExtensionMessage({
      type: "tab.detached",
      tabId: 23,
      grantId: "old-grant-session-0001",
    });
    expect(service.status("session-1").granted).toBeDefined();
    expect(
      JSON.parse((await service.dispatch("session-1", { action: "click", ref: "e1" }))!),
    ).toMatchObject({ ok: false });
    expect(actions).toBe(0);
  });

  test("rejects oversized high-level requests before native transport", async () => {
    let actions = 0;
    const { service } = await runtimeFixture(async (type) => {
      if (type === "tab.get") return { id: 23, url: "https://example.test", title: "Authorized" };
      if (type === "browser.action") actions += 1;
      return { ok: true };
    });
    const result = JSON.parse(
      (await service.dispatch("session-1", {
        action: "navigate",
        url: `https://example.test/${"x".repeat(1024 * 1024)}`,
      }))!,
    );
    expect(result).toMatchObject({ ok: false });
    expect(result.detail).toContain("size limit");
    expect(actions).toBe(0);
  });
});
