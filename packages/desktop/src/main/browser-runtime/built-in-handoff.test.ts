import { describe, expect, test } from "bun:test";
import type { WebContents } from "electron";
import type { GuestRecord } from "../browser-driver/active-guest.js";
import { BuiltInBrowserHandoffGrants } from "./built-in-handoff.js";
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
    await grants.dispatch(claim.sessionId, { action: "requestTakeover" });
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

    expect(() =>
      grants.grant({ sessionId: "session-1", guestId: 42, sourceWindowId: 99 }),
    ).toThrow("window that owns");
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

    const tabs = JSON.parse(
      (await grants.dispatch("session-1", { action: "listTabs" })) ?? "null",
    );
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
