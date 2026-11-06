import { describe, expect, test } from "bun:test";
import type { WebContents } from "electron";
import type { GuestRecord } from "../browser-driver/active-guest.js";
import {
  BuiltInBrowserHandoffGrants,
  parseBuiltInBrowserGrantLifetime,
} from "./built-in-handoff.js";
import { handleBrowserAction, releaseGuest } from "../browser-driver/automation-host.js";
import type { BrowserBridge } from "@cjhyy/code-shell-core";

function fakeRecord(overrides: Partial<GuestRecord> = {}): GuestRecord {
  const destroyedListeners: Array<() => void> = [];
  const guest = {
    id: 42,
    getURL: () => "https://signed-in.example.test/inbox",
    getTitle: () => "Inbox",
    isDestroyed: () => false,
    once: (event: string, listener: () => void) => {
      if (event === "destroyed") destroyedListeners.push(listener);
      return guest;
    },
    removeListener: (event: string, listener: () => void) => {
      if (event === "destroyed") {
        const index = destroyedListeners.indexOf(listener);
        if (index >= 0) destroyedListeners.splice(index, 1);
      }
      return guest;
    },
    emit: (event: string) => {
      if (event === "destroyed") for (const listener of [...destroyedListeners]) listener();
      return true;
    },
  } as unknown as WebContents;
  return {
    guest,
    guestId: 42,
    bucket: "task-bucket",
    partition: "persist:browser:task-bucket",
    engineSessionId: "session-1",
    windowId: 7,
    attachedAt: 1,
    lastFocusedAt: 1,
    source: "panel",
    ...overrides,
  };
}

describe("BuiltInBrowserHandoffGrants", () => {
  test("session grants stay on the exact selected tab across turns without a timer", async () => {
    let now = 1_000;
    const record = fakeRecord();
    const calls: string[] = [];
    const grants = new BuiltInBrowserHandoffGrants({
      guestRecordForId: (id) => (id === record.guestId ? record : null),
      bucketForSession: (id) => (id === "session-bound" ? record.bucket : "other-bucket"),
      now: () => now,
      authorizeGuest: () => calls.push("authorize"),
      releaseGuest: () => calls.push("release"),
    });
    const claim = {
      sessionId: "session-bound",
      guestId: 42,
      sourceWindowId: 7,
      lifetime: "session" as const,
    };
    const first = grants.grant(claim);
    expect(first.grantedAt).toBe(1_000);
    expect(first.expiresAt).toBeUndefined();
    expect(
      JSON.parse((await grants.dispatch(claim.sessionId, { action: "listTabs" }))!)[0],
    ).toMatchObject({
      tabId: "42",
      active: true,
    });
    now += 7 * 24 * 60 * 60 * 1_000;
    expect(grants.grant(claim)).toEqual(first);
    expect(
      JSON.parse((await grants.dispatch(claim.sessionId, { action: "listTabs" }))!)[0],
    ).toMatchObject({
      tabId: "42",
      active: true,
    });
    expect(calls).toEqual(["authorize"]);
    expect(() => grants.grant({ ...claim, sourceWindowId: 99 })).toThrow("window that owns");
    expect(await grants.dispatch("other-session", { action: "listTabs" })).toBeUndefined();
    expect(() => grants.grant({ ...claim, sessionId: "other-session" })).toThrow("does not belong");
    grants.clearSession(claim.sessionId);
    expect(calls).toEqual(["authorize", "release"]);
    expect(grants.status(claim.sessionId).granted).toBe(false);
  });

  test("reselecting a session tab preserves in-flight actions and does not resume takeover", async () => {
    const record = fakeRecord();
    const calls: string[] = [];
    const activeChecks: Array<() => boolean> = [];
    const grants = new BuiltInBrowserHandoffGrants({
      guestRecordForId: () => record,
      bucketForSession: () => record.bucket,
      authorizeGuest: () => calls.push("authorize"),
      releaseGuest: () => calls.push("release"),
      dispatchAction: async (_request, deps) => {
        activeChecks.push(deps!.isActive!);
        return "ok";
      },
    });
    const claim = {
      sessionId: "session-paused",
      guestId: 42,
      sourceWindowId: 7,
      lifetime: "session" as const,
    };
    const first = grants.grant(claim);
    await grants.dispatch(claim.sessionId, { action: "snapshot" });
    expect(activeChecks[0]()).toBe(true);
    expect(grants.grant(claim)).toEqual(first);
    expect(activeChecks[0]()).toBe(true);
    await grants.dispatch(claim.sessionId, { action: "requestTakeover" });
    expect(activeChecks[0]()).toBe(false);
    expect(grants.grant(claim)).toEqual(first);
    expect(activeChecks[0]()).toBe(false);
    expect(calls).toEqual(["authorize", "release"]);
    grants.clearSession(claim.sessionId);
  });

  test("closing or revoking a session tab requires another explicit selection", async () => {
    const record = fakeRecord();
    let available = true;
    const grants = new BuiltInBrowserHandoffGrants({
      guestRecordForId: () => (available ? record : null),
      bucketForSession: () => record.bucket,
      authorizeGuest: () => {},
      releaseGuest: () => {},
    });
    const claim = {
      sessionId: "session-closed",
      guestId: 42,
      sourceWindowId: 7,
      lifetime: "session" as const,
    };
    grants.grant(claim);
    grants.revoke(claim.sessionId);
    expect(grants.status(claim.sessionId).granted).toBe(false);
    expect(
      JSON.parse((await grants.dispatch(claim.sessionId, { action: "listTabs" }))!),
    ).toMatchObject({
      ok: false,
      code: "NEEDS_HUMAN",
    });
    grants.grant(claim);
    available = false;
    record.guest.emit("destroyed");
    expect(
      JSON.parse((await grants.dispatch(claim.sessionId, { action: "listTabs" }))!),
    ).toMatchObject({
      ok: false,
      code: "NEEDS_HUMAN",
    });
    expect(() => grants.grant(claim)).toThrow("no longer available");
    grants.clearSession(claim.sessionId);
  });

  test("explicitly selecting a different tab retires the prior session target", async () => {
    const firstRecord = fakeRecord();
    const secondRecord = fakeRecord({ guestId: 43 });
    const records = new Map([
      [42, firstRecord],
      [43, secondRecord],
    ]);
    const released: number[] = [];
    const activeChecks: Array<() => boolean> = [];
    const grants = new BuiltInBrowserHandoffGrants({
      guestRecordForId: (id) => records.get(id) ?? null,
      bucketForSession: () => firstRecord.bucket,
      authorizeGuest: () => {},
      releaseGuest: (id) => released.push(id),
      dispatchAction: async (_request, deps) => {
        activeChecks.push(deps!.isActive!);
        return JSON.stringify(deps!.listTabs!());
      },
    });
    const claim = {
      sessionId: "session-switch",
      guestId: 42,
      sourceWindowId: 7,
      lifetime: "session" as const,
    };
    grants.grant(claim);
    expect(
      JSON.parse((await grants.dispatch(claim.sessionId, { action: "listTabs" }))!)[0].tabId,
    ).toBe("42");
    grants.grant({ ...claim, guestId: 43 });
    expect(activeChecks[0]()).toBe(false);
    expect(released).toEqual([42]);
    expect(
      JSON.parse((await grants.dispatch(claim.sessionId, { action: "listTabs" }))!)[0].tabId,
    ).toBe("43");
    firstRecord.guest.emit("destroyed");
    expect(grants.status(claim.sessionId)).toMatchObject({ granted: true, guestId: 43 });
    grants.clearSession(claim.sessionId);
    expect(released).toEqual([42, 43]);
  });

  test("a session grant is retired when its conversation bucket changes", async () => {
    const record = fakeRecord();
    let bucket = record.bucket;
    const calls: string[] = [];
    const grants = new BuiltInBrowserHandoffGrants({
      guestRecordForId: () => record,
      bucketForSession: () => bucket,
      authorizeGuest: () => calls.push("authorize"),
      releaseGuest: () => calls.push("release"),
      dispatchAction: async () => {
        calls.push("action");
        return "ok";
      },
    });
    const claim = {
      sessionId: "session-rebound",
      guestId: 42,
      sourceWindowId: 7,
      lifetime: "session" as const,
    };
    grants.grant(claim);
    bucket = "different-conversation";
    expect(
      JSON.parse((await grants.dispatch(claim.sessionId, { action: "snapshot" }))!),
    ).toMatchObject({
      ok: false,
      code: "NEEDS_HUMAN",
    });
    bucket = record.bucket;
    expect(grants.status(claim.sessionId).granted).toBe(false);
    expect(calls).toEqual(["authorize", "release"]);
    grants.clearSession(claim.sessionId);
  });

  test("session lifetime rejects unknown choices and conflicting TTLs", () => {
    expect(parseBuiltInBrowserGrantLifetime(undefined, 1_000)).toBeUndefined();
    expect(parseBuiltInBrowserGrantLifetime("session")).toBe("session");
    for (const invalid of [null, false, "permanent", "temporary", {}, 1]) {
      expect(() => parseBuiltInBrowserGrantLifetime(invalid)).toThrow("lifetime is invalid");
    }
    for (const ttl of [0, 1_000, null, "1000"]) {
      expect(() => parseBuiltInBrowserGrantLifetime("session", ttl)).toThrow("time limit");
    }
  });

  test("window/Session authority is checked at grant and at dispatch without a UI poll", async () => {
    const record = fakeRecord();
    let current = false;
    const calls: string[] = [];
    const grants = new BuiltInBrowserHandoffGrants({
      guestRecordForId: () => record,
      bucketForSession: () => "task-bucket",
      authorizeGuest: () => calls.push("authorize"),
      releaseGuest: () => calls.push("release"),
      dispatchAction: async () => {
        calls.push("action");
        return "ok";
      },
    });
    const claim = {
      sessionId: "cold-session",
      guestId: 42,
      sourceWindowId: 7,
      lifetime: "session" as const,
      assertCurrent: () => {
        if (!current) throw new Error("Session owner changed");
      },
    };
    expect(() => grants.grant(claim)).toThrow("Session owner changed");
    expect(calls).toEqual([]);
    current = true;
    expect(grants.grant(claim).granted).toBe(true);
    current = false;
    expect(
      JSON.parse((await grants.dispatch(claim.sessionId, { action: "listTabs" }))!),
    ).toMatchObject({ ok: false, code: "NEEDS_HUMAN" });
    expect(calls).toEqual(["authorize", "release"]);
    // Restoring the old authority does not resurrect the expired claim or
    // silently choose a different target.
    current = true;
    expect(grants.status(claim.sessionId).granted).toBe(false);
    expect(
      JSON.parse((await grants.dispatch(claim.sessionId, { action: "listTabs" }))!),
    ).toMatchObject({ ok: false, code: "NEEDS_HUMAN" });
    grants.clearSession(claim.sessionId);
  });

  test("authority lost while the browser driver starts prevents the queued action", async () => {
    releaseGuest(42);
    const record = fakeRecord();
    let current = true;
    let finishDriver!: (driver: BrowserBridge) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let navigations = 0;
    const grants = new BuiltInBrowserHandoffGrants({
      guestRecordForId: () => record,
      bucketForSession: () => "task-bucket",
      authorizeGuest: () => {},
      releaseGuest,
      dispatchAction: (request, deps) =>
        handleBrowserAction(request, {
          ...deps,
          policy: () => ({ allowedDomains: [] }),
          createDriver: () =>
            new Promise<BrowserBridge>((resolve) => {
              finishDriver = resolve;
              markStarted();
            }),
        }),
    });
    grants.grant({
      sessionId: "cold-pending-driver",
      guestId: 42,
      sourceWindowId: 7,
      assertCurrent: () => {
        if (!current) throw new Error("granting window closed");
      },
    });
    const action = grants.dispatch("cold-pending-driver", {
      action: "navigate",
      url: "https://example.test/",
    });
    await started;
    current = false;
    finishDriver({
      navigate: async () => {
        navigations++;
        return { ok: true };
      },
    } as BrowserBridge);
    expect(JSON.parse((await action)!)).toMatchObject({ ok: false, code: "NEEDS_HUMAN" });
    expect(navigations).toBe(0);
    grants.clearSession("cold-pending-driver");
    releaseGuest(42);
  });

  test("a closed panel stops actions and cannot fall back to a task window", async () => {
    const record = fakeRecord();
    let live = true;
    let dispatched = false;
    const grants = new BuiltInBrowserHandoffGrants({
      guestRecordForId: () => (live ? record : null),
      bucketForSession: () => record.bucket,
      authorizeGuest: () => {},
      releaseGuest: () => {},
      dispatchAction: async () => {
        dispatched = true;
        return "{}";
      },
      now: () => 100,
    });
    grants.grant({ sessionId: "session-1", guestId: 42, sourceWindowId: 7 });
    live = false;
    try {
      const result = JSON.parse((await grants.dispatch("session-1", { action: "snapshot" }))!);
      expect(result).toMatchObject({ ok: false, code: "NEEDS_HUMAN", retryable: false });
      expect(result.detail).toContain("Stop browser actions");
      expect(result.detail).not.toContain("or use the Runtime");
      const repeated = await grants.dispatch("session-1", { action: "requestTakeover" });
      expect(repeated).toBeDefined();
      expect(JSON.parse(repeated!)).toMatchObject({ ok: false, code: "NEEDS_HUMAN" });
      expect(dispatched).toBe(false);
    } finally {
      grants.clearSession("session-1");
    }
  });

  test("takeover invalidates queued resumes without revoking the capability grant", async () => {
    releaseGuest(42);
    const record = fakeRecord();
    const navigations: string[] = [];
    let resumes = 0;
    let finishWait!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const driver = {
      waitForLoad: () =>
        new Promise((resolve) => {
          finishWait = () => resolve({ ok: false, detail: "control released" });
          markStarted();
        }),
      navigate: async (url: string) => {
        navigations.push(url);
        return { ok: true };
      },
      dispose: () => finishWait?.(),
    } as unknown as BrowserBridge;
    const grants = new BuiltInBrowserHandoffGrants({
      guestRecordForId: () => record,
      bucketForSession: () => "task-bucket",
      authorizeGuest: () => {},
      releaseGuest,
      dispatchAction: (request, deps) =>
        handleBrowserAction(request, {
          ...deps,
          policy: () => ({ allowedDomains: [] }),
          createDriver: () => driver,
          resumeGuest: async () => {
            resumes++;
          },
        }),
    });
    const claim = { sessionId: "queued-resume", guestId: 42, sourceWindowId: 7 };
    grants.grant(claim);
    const waiting = grants.dispatch(claim.sessionId, { action: "waitForLoad" });
    await started;
    const oldResume = grants.dispatch(claim.sessionId, { action: "resumeControl" });
    const oldNavigation = grants.dispatch(claim.sessionId, {
      action: "navigate",
      url: "https://old.example/",
    });
    const takeover = JSON.parse(
      (await grants.dispatch(claim.sessionId, { action: "requestTakeover" }))!,
    );
    expect(takeover).toMatchObject({ ok: true, code: "OK" });
    expect(takeover.detail).toContain("granted BrowserPanel tab");
    expect(takeover.detail).toContain("Panel visibility is unchanged");
    await waiting;
    expect(JSON.parse((await oldResume)!)).toMatchObject({ ok: false, code: "NEEDS_HUMAN" });
    expect(JSON.parse((await oldNavigation)!)).toMatchObject({ ok: false, code: "NEEDS_HUMAN" });
    expect(resumes).toBe(0);
    expect(navigations).toEqual([]);
    expect(grants.status(claim.sessionId).granted).toBe(true);
    expect(
      JSON.parse((await grants.dispatch(claim.sessionId, { action: "resumeControl" }))!),
    ).toMatchObject({ ok: true });
    expect(resumes).toBe(1);
    await grants.dispatch(claim.sessionId, { action: "navigate", url: "https://new.example/" });
    expect(navigations).toEqual(["https://new.example/"]);
    grants.clearSession(claim.sessionId);
  });

  test("a new grant never revives an older queued navigation", async () => {
    releaseGuest(42);
    const record = fakeRecord();
    const navigations: string[] = [];
    let finishWait!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const driver = {
      waitForLoad: () =>
        new Promise((resolve) => {
          finishWait = () => resolve({ ok: false, detail: "revoked" });
          markStarted();
        }),
      navigate: async (url: string) => {
        navigations.push(url);
        return { ok: true };
      },
      dispose: () => finishWait?.(),
    } as unknown as BrowserBridge;
    const grants = new BuiltInBrowserHandoffGrants({
      guestRecordForId: () => record,
      bucketForSession: () => "task-bucket",
      authorizeGuest: () => {},
      releaseGuest,
      dispatchAction: (request, deps) =>
        handleBrowserAction(request, {
          ...deps,
          policy: () => ({ allowedDomains: [] }),
          createDriver: () => driver,
        }),
    });
    const claim = { sessionId: "queued-grant", guestId: 42, sourceWindowId: 7 };
    grants.grant(claim);
    const waiting = grants.dispatch(claim.sessionId, { action: "waitForLoad" });
    await started;
    const old = grants.dispatch(claim.sessionId, {
      action: "navigate",
      url: "https://old.example/",
    });
    grants.revoke(claim.sessionId);
    grants.grant(claim);
    await waiting;
    expect(JSON.parse((await old)!)).toMatchObject({ ok: false, code: "NEEDS_HUMAN" });
    expect(navigations).toEqual([]);
    await grants.dispatch(claim.sessionId, { action: "navigate", url: "https://new.example/" });
    expect(navigations).toEqual(["https://new.example/"]);
    grants.clearSession(claim.sessionId);
  });

  test("revocation while driver creation waits is checked again before execution", async () => {
    releaseGuest(42);
    const record = fakeRecord();
    let finishDriver!: (driver: BrowserBridge) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let navigations = 0;
    const grants = new BuiltInBrowserHandoffGrants({
      guestRecordForId: () => record,
      bucketForSession: () => "task-bucket",
      authorizeGuest: () => {},
      releaseGuest,
      dispatchAction: (request, deps) =>
        handleBrowserAction(request, {
          ...deps,
          policy: () => ({ allowedDomains: [] }),
          createDriver: () =>
            new Promise<BrowserBridge>((resolve) => {
              finishDriver = resolve;
              markStarted();
            }),
        }),
    });
    const claim = { sessionId: "await-grant", guestId: 42, sourceWindowId: 7 };
    grants.grant(claim);
    const old = grants.dispatch(claim.sessionId, {
      action: "navigate",
      url: "https://old.example/",
    });
    await started;
    grants.revoke(claim.sessionId);
    grants.grant(claim);
    finishDriver({
      navigate: async () => {
        navigations++;
        return { ok: true };
      },
    } as BrowserBridge);
    expect(JSON.parse((await old)!)).toMatchObject({ ok: false, code: "NEEDS_HUMAN" });
    expect(navigations).toBe(0);
    grants.clearSession(claim.sessionId);
    releaseGuest(42);
  });

  test("revocation and TTL release control, while another explicit grant authorizes anew", async () => {
    const record = fakeRecord();
    const calls: string[] = [];
    const grants = new BuiltInBrowserHandoffGrants({
      guestRecordForId: () => record,
      bucketForSession: () => "task-bucket",
      authorizeGuest: (guest) => {
        calls.push(`authorize:${guest.id}`);
      },
      releaseGuest: (id) => {
        calls.push(`release:${id}`);
      },
    });
    const grant = { sessionId: "session-ttl", guestId: 42, sourceWindowId: 7 };
    grants.grant(grant);
    grants.revoke("session-ttl");
    expect(calls).toEqual(["authorize:42", "release:42"]);
    grants.grant({ ...grant, ttlMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toEqual(["authorize:42", "release:42", "authorize:42", "release:42"]);
    expect(grants.status("session-ttl").granted).toBe(false);
  });

  test("requires an owner-window user gesture and the task's own bucket", () => {
    const record = fakeRecord();
    const grants = new BuiltInBrowserHandoffGrants({
      guestRecordForId: () => record,
      bucketForSession: () => "task-bucket",
      now: () => 100,
    });

    expect(() => grants.grant({ sessionId: "session-1", guestId: 42, sourceWindowId: 99 })).toThrow(
      "window that owns",
    );
    expect(() =>
      new BuiltInBrowserHandoffGrants({
        guestRecordForId: () => record,
        bucketForSession: () => "another-bucket",
      }).grant({ sessionId: "session-1", guestId: 42, sourceWindowId: 7 }),
    ).toThrow("does not belong");
  });

  test("pins one exact tab, expires, and never follows active-tab focus", async () => {
    let now = 1_000;
    const record = fakeRecord();
    const grants = new BuiltInBrowserHandoffGrants({
      guestRecordForId: (guestId) => (guestId === 42 ? record : null),
      bucketForSession: () => "task-bucket",
      now: () => now,
    });
    const granted = grants.grant({
      sessionId: "session-1",
      guestId: 42,
      sourceWindowId: 7,
      ttlMs: 5_000,
    });
    expect(granted).toMatchObject({
      granted: true,
      guestId: 42,
      url: "https://signed-in.example.test/inbox",
      expiresAt: 6_000,
    });

    const tabs = JSON.parse((await grants.dispatch("session-1", { action: "listTabs" })) ?? "null");
    expect(tabs).toEqual([
      {
        tabId: "42",
        url: "https://signed-in.example.test/inbox",
        title: "Inbox",
        active: true,
      },
    ]);

    now = 6_000;
    expect(grants.status("session-1")).toEqual({ granted: false, sessionId: "session-1" });
    expect(JSON.parse((await grants.dispatch("session-1", { action: "listTabs" }))!)).toMatchObject(
      {
        ok: false,
        code: "NEEDS_HUMAN",
      },
    );
    // An unrelated, never-granted session still uses its ordinary runtime.
    expect(await grants.dispatch("never-granted", { action: "listTabs" })).toBeUndefined();
    grants.grant({ sessionId: "session-1", guestId: 42, sourceWindowId: 7 });
    expect(JSON.parse((await grants.dispatch("session-1", { action: "listTabs" }))!)).toHaveLength(
      1,
    );
    grants.clearSession("session-1");
    expect(await grants.dispatch("session-1", { action: "listTabs" })).toBeUndefined();
  });
});
