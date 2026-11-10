import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationSessionRoute, PetLongTask } from "@cjhyy/code-shell-pet";
import type { ImGatewayOwnerChannel } from "../im-gateway-service.js";
import {
  createPetNoticeControls,
  PET_NOTICES_CHANGED_CHANNEL,
  registerPetNoticeIpc,
  type PetNoticeControls,
} from "./pet-notice-ipc.js";
import { wirePetNotices, type PetNoticeWiring } from "./pet-notice-wiring.js";
import { PetRuleStoreError } from "./pet-rule-store.js";
import type { DesktopPetSession } from "./pet-state-aggregator.js";

const SID = "s-work";
const MIMI = "s-mimi";
const NOW = 1_700_000_000_000;

let dir: string;
let wiring: PetNoticeWiring | undefined;

interface Fixture {
  wiring: PetNoticeWiring;
  controls: PetNoticeControls;
  channels: ImGatewayOwnerChannel[];
  routes: ConversationSessionRoute[];
  tasks: PetLongTask[];
  goals: Set<string>;
  settings: { value: unknown };
}

function session(id: string): DesktopPetSession {
  return {
    agentSessionId: id,
    title: "修登录",
    runState: "idle",
    queueDepth: 0,
    lastActivityAt: NOW,
    pendingDecisionCount: 0,
    freshness: { source: "live", observedAt: NOW, workerState: "active" },
  } as DesktopPetSession;
}

function fixture(): Fixture {
  const channels: ImGatewayOwnerChannel[] = [
    { id: "wechat", label: "微信", ready: "unknown", targetId: "wechat:owner", isDirect: true },
    { id: "lark", label: "飞书", ready: "unavailable" },
  ];
  const routes: ConversationSessionRoute[] = [];
  const tasks: PetLongTask[] = [];
  const goals = new Set<string>();
  const settings = { value: {} as unknown };
  const created = wirePetNotices({
    userDataDir: dir,
    bridge: { setHostActionHandler: () => () => undefined },
    projection: {
      // Mimi's own Session is never in the work-Session projection.
      getSnapshot: () => ({
        version: 1,
        generation: 1,
        workerState: "active",
        sessions: [session(SID)],
        pending: [],
        observedAt: NOW,
        workMemorySegments: [],
      }),
      subscribe: () => () => undefined,
    },
    longTasks: {
      activeForSession: (id) => tasks.find((task) => task.sessionId === id),
      getSnapshot: () => ({ tasks }),
    },
    sessionRoutes: () => ({
      notifyRoutesForSession: async (id) => routes.filter((route) => route.sessionId === id),
    }),
    gateway: {
      ownerChannels: () => channels,
      listOwnerMessageTargets: () => [],
      resolveOwnerTarget: () => undefined,
      lastOwnerInboundChannel: () => "wechat",
      isOwnerConversation: () => false,
    },
    outbox: {
      publish: async () => undefined,
      revoke: async () => undefined,
      state: () => undefined,
    },
    notifyDesktop: async () => undefined,
    readSettings: () => settings.value,
    presence: { getSystemIdleTimeSec: () => 0, hasFocusedWindow: () => true },
    isMimiSession: (id) => id === MIMI,
    now: () => NOW,
    log: () => undefined,
  });
  wiring = created;
  const controls = createPetNoticeControls({
    notices: created,
    ownerChannels: () => channels,
    goals: { readActiveGoal: (id) => (goals.has(id) ? { paused: false } : undefined) },
    now: () => NOW + 5,
  });
  return { wiring: created, controls, channels, routes, tasks, goals, settings };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pet-notice-ipc-"));
});

afterEach(async () => {
  wiring?.dispose();
  wiring = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe("Session bell", () => {
  test("off by default; on arms an owner rule on every event for the next turn", async () => {
    const { controls, wiring } = fixture();
    expect(await controls.sessionBell(SID)).toEqual({
      available: true,
      on: false,
      delegated: false,
    });

    const bell = await controls.setSessionBell(SID, true);
    expect(bell).toEqual({
      available: true,
      on: true,
      origin: "user",
      delegated: false,
      ruleId: expect.any(String),
      channel: "auto",
      imLabel: "微信",
      ready: "unknown",
    });
    const [rule] = wiring.ruleStore.activeForSession(SID);
    expect(rule).toMatchObject({
      id: bell.ruleId,
      origin: "user",
      createdBy: "bell",
      channel: "auto",
      attention: "always",
      target: { kind: "owner" },
      when: { kind: "session", scope: "turn", events: ["done", "failed", "blocked"] },
    });
    expect(rule?.when.kind === "session" && rule.when.armedAt).toBe(NOW + 5);
    expect(await controls.sessionBell(SID)).toEqual(bell);
  });

  test("a rule that just fired says so, so the renderer leaves that outcome to main", async () => {
    const { controls, wiring } = fixture();
    // Switching the bell off is not a notice.
    await controls.setSessionBell(SID, true);
    expect(await controls.setSessionBell(SID, false)).toEqual({
      available: true,
      on: false,
      delegated: false,
    });
    await controls.setSessionBell(SID, true);
    const [rule] = wiring.ruleStore.activeForSession(SID);
    await wiring.ruleStore.update(rule!.id, rule!.version, { state: "spent" });
    expect(await controls.sessionBell(SID)).toEqual({
      available: true,
      on: false,
      delegated: false,
      firedRecently: true,
    });
  });

  test("waits for the Goal when one drives the Session, and follows a bound IM chat", async () => {
    const { controls, wiring, goals, routes } = fixture();
    goals.add(SID);
    routes.push({
      schemaVersion: 1,
      id: "route-1",
      routeKey: "im:wechat\u0000chat-1\u0000owner-1",
      channel: "wechat",
      target: "chat-1",
      senderId: "owner-1",
      sessionId: SID,
      sessionTitle: "修登录",
      mode: "bound",
      origin: "enter",
      status: "active",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    } as ConversationSessionRoute);
    await controls.setSessionBell(SID, true);
    const [rule] = wiring.ruleStore.activeForSession(SID);
    expect(rule?.when).toMatchObject({ scope: "goal" });
    expect(rule?.target).toMatchObject({
      kind: "route",
      route: { channel: "wechat", target: "chat-1", isDirectMessage: true },
    });
  });

  function armDelegation(wiring: PetNoticeWiring) {
    return wiring.ruleStore.upsertSessionRule({
      sessionId: SID,
      createdBy: "delegation",
      events: ["done", "failed", "blocked"],
      scope: "turn",
      channel: "auto",
      attention: "always",
      target: {
        kind: "route",
        route: { kind: "im-gateway", channel: "lark", target: "dm-1", senderId: "u" },
      },
      origin: "delegation",
      armedAt: NOW,
    });
  }

  test("off cancels only the owner's rules; Mimi's delegation rule then shows read-only", async () => {
    const { controls, wiring } = fixture();
    await controls.setSessionBell(SID, true);
    const delegation = await armDelegation(wiring);
    await wiring.ruleStore.upsertSessionRule({
      sessionId: "s-other",
      createdBy: "notify-me",
      events: ["done"],
      scope: "turn",
      channel: "auto",
      attention: "always",
      target: { kind: "owner" },
      origin: "user",
      armedAt: NOW,
    });
    await wiring.ruleStore.setSystemRule("all-sessions", { state: "active" });
    expect(wiring.ruleStore.activeForSession(SID)).toHaveLength(3);
    // Both: the owner's rule speaks for the bell, and the delegation is noted.
    expect(await controls.sessionBell(SID)).toMatchObject({
      on: true,
      origin: "user",
      delegated: true,
      channel: "auto",
    });

    expect(await controls.setSessionBell(SID, false)).toEqual({
      available: true,
      on: true,
      origin: "delegation",
      delegated: true,
      ruleId: delegation.id,
      channel: "auto",
      // A rule from an IM conversation goes back to that conversation's channel.
      imLabel: "飞书",
      ready: "unavailable",
    });
    const states = wiring.ruleStore
      .list()
      .map((rule) => [
        rule.when.kind === "session" ? rule.when.sessionId : rule.id,
        rule.origin,
        rule.state,
      ]);
    expect(states).toContainEqual([SID, "user", "cancelled"]);
    expect(states).toContainEqual([SID, "delegation", "active"]);
    // Another Session and the system rule are not the bell's to switch off.
    expect(states).toContainEqual(["s-other", "user", "active"]);
    expect(wiring.ruleStore.systemRule("all-sessions").state).toBe("active");

    // Off again with only the delegation rule left changes nothing.
    await controls.setSessionBell(SID, false);
    expect(wiring.ruleStore.get(delegation.id)?.state).toBe("active");
  });

  test("the bell on a delegated Session takes Mimi's rule over, so off switches it off", async () => {
    const { controls, wiring, tasks } = fixture();
    const delegation = await armDelegation(wiring);
    // The bell resolves to the same conversation: the delegated task's IM origin.
    tasks.push({
      id: "task-1",
      sessionId: SID,
      status: "running",
      completionTarget: { kind: "im-gateway", channel: "lark", target: "dm-1", senderId: "u" },
    } as PetLongTask);
    expect(await controls.setSessionBell(SID, true)).toMatchObject({
      on: true,
      origin: "user",
      delegated: false,
      ruleId: delegation.id,
      channel: "auto",
    });
    expect(wiring.ruleStore.get(delegation.id)).toMatchObject({
      origin: "user",
      createdBy: "bell",
    });
    expect(await controls.setSessionBell(SID, false)).toEqual({
      available: true,
      on: false,
      delegated: false,
    });
    expect(wiring.ruleStore.get(delegation.id)?.state).toBe("cancelled");
  });

  test("a delegation rule alone shows as delegated, not as the owner's bell", async () => {
    const { controls, wiring } = fixture();
    await armDelegation(wiring);
    expect(await controls.sessionBell(SID)).toMatchObject({
      available: true,
      on: true,
      origin: "delegation",
      delegated: true,
    });
  });

  test("off retries once against the fresh version after a concurrent write", async () => {
    const { controls, wiring } = fixture();
    await controls.setSessionBell(SID, true);
    const store = wiring.ruleStore;
    const update = store.update.bind(store);
    let conflicts = 0;
    store.update = async (id, version, patch) => {
      if (conflicts === 0) {
        conflicts += 1;
        // Someone else touched the rule between our read and our write.
        await update(id, version, { note: "edited" });
        throw new PetRuleStoreError("version_conflict");
      }
      return update(id, version, patch);
    };
    expect(await controls.setSessionBell(SID, false)).toEqual({
      available: true,
      on: false,
      delegated: false,
    });
    expect(conflicts).toBe(1);
    expect(store.list()[0]).toMatchObject({ state: "cancelled", note: "edited" });
  });

  test("Mimi's own Session and unknown Sessions are unavailable, never armed", async () => {
    const { controls, wiring } = fixture();
    const unavailable = { available: false, on: false, delegated: false };
    expect(await controls.sessionBell(MIMI)).toEqual(unavailable);
    expect(await controls.setSessionBell(MIMI, true)).toEqual(unavailable);
    expect(await controls.sessionBell("s-gone")).toEqual(unavailable);
    expect(wiring.ruleStore.list()).toEqual([]);
  });

  test("a paused Goal does not make the bell wait for it", async () => {
    const { wiring } = fixture();
    const paused = createPetNoticeControls({
      notices: wiring,
      ownerChannels: () => [],
      goals: { readActiveGoal: () => ({ paused: true }) },
    });
    await paused.setSessionBell(SID, true);
    expect(wiring.ruleStore.activeForSession(SID)[0]?.when).toMatchObject({ scope: "turn" });
  });
});

describe("notices state and system rule", () => {
  test("get-state lists channels, the system rule and settings with defaults", async () => {
    const { controls, settings } = fixture();
    settings.value = { pet: { notifications: { maxPerHour: 9, delegatedFromDesktop: "desktop" } } };
    expect(await controls.getState()).toEqual({
      channels: [
        { id: "wechat", label: "微信", ready: "unknown" },
        { id: "lark", label: "飞书", ready: "unavailable" },
      ],
      systemRule: { state: "paused", channel: "auto", events: ["done", "failed", "blocked"] },
      settings: {
        quietHours: { enabled: true, start: "23:00", end: "08:30" },
        maxPerHour: 9,
        maxP0PerHour: 12,
        mergeWindowSec: 600,
        presenceIdleSec: 120,
        delegatedFromDesktop: "desktop",
      },
    });
  });

  test("set-system-rule toggles and tunes the every-Session rule", async () => {
    const { controls, wiring } = fixture();
    expect(await controls.setSystemRule({ state: "active" })).toEqual({
      state: "active",
      channel: "auto",
      events: ["done", "failed", "blocked"],
    });
    expect(await controls.setSystemRule({ channel: "wechat", events: ["blocked"] })).toEqual({
      state: "active",
      channel: "wechat",
      events: ["blocked"],
    });
    expect(wiring.ruleStore.systemRule("all-sessions").when.events).toEqual(["blocked"]);
    await expect(controls.setSystemRule({ channel: "telegram" })).rejects.toThrow(
      "unknown notice channel",
    );
  });

  test("rule and settings changes reach subscribers", async () => {
    const { controls, wiring } = fixture();
    let calls = 0;
    const off = controls.subscribe(() => {
      calls += 1;
    });
    await controls.setSessionBell(SID, true);
    expect(calls).toBe(1);
    wiring.settingsChanged();
    expect(calls).toBe(2);
    off();
    wiring.settingsChanged();
    expect(calls).toBe(2);
  });

  test("a settings write is visible to routing at once (no stale cache)", async () => {
    const { wiring, settings } = fixture();
    expect(wiring.settings().maxPerHour).toBe(6);
    settings.value = { pet: { notifications: { maxPerHour: 2 } } };
    expect(wiring.settings().maxPerHour).toBe(6);
    wiring.settingsChanged();
    expect(wiring.settings().maxPerHour).toBe(2);
  });
});

describe("pet:notices IPC", () => {
  function registered(controls: PetNoticeControls) {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const dispose = registerPetNoticeIpc({
      ipcMain: {
        handle: (channel, listener) => handlers.set(channel, listener),
        removeHandler: (channel) => handlers.delete(channel),
      },
      windows: () => [
        {
          isDestroyed: () => false,
          webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
        },
      ],
      controls,
    });
    const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
    return { handlers, sent, dispose, call };
  }

  test("routes validated requests and pushes changes", async () => {
    const { controls } = fixture();
    const ipc = registered(controls);
    expect([...ipc.handlers.keys()].sort()).toEqual([
      "pet:notices:get-state",
      "pet:notices:session-bell",
      "pet:notices:set-session-bell",
      "pet:notices:set-system-rule",
    ]);
    expect(await ipc.call("pet:notices:session-bell", SID)).toEqual({
      available: true,
      on: false,
      delegated: false,
    });
    expect(
      await ipc.call("pet:notices:set-session-bell", { sessionId: SID, on: true }),
    ).toMatchObject({ on: true });
    expect(ipc.sent).toEqual([{ channel: PET_NOTICES_CHANGED_CHANNEL, payload: null }]);
    expect(await ipc.call("pet:notices:set-system-rule", { state: "active" })).toMatchObject({
      state: "active",
    });
    expect(await ipc.call("pet:notices:get-state")).toMatchObject({
      systemRule: { state: "active" },
    });
    ipc.dispose();
    expect(ipc.handlers.size).toBe(0);
  });

  test("rejects malformed requests before touching rules", () => {
    const { controls } = fixture();
    const ipc = registered(controls);
    expect(() => ipc.call("pet:notices:get-state", "x")).toThrow();
    expect(() => ipc.call("pet:notices:session-bell")).toThrow();
    expect(() => ipc.call("pet:notices:session-bell", "../etc")).toThrow();
    expect(() => ipc.call("pet:notices:set-session-bell", { sessionId: SID })).toThrow();
    expect(() =>
      ipc.call("pet:notices:set-session-bell", { sessionId: SID, on: true, scope: "goal" }),
    ).toThrow();
    expect(() => ipc.call("pet:notices:set-system-rule", {})).toThrow();
    expect(() => ipc.call("pet:notices:set-system-rule", { state: "spent" })).toThrow();
    expect(() => ipc.call("pet:notices:set-system-rule", { events: ["done", "done"] })).toThrow();
    expect(() => ipc.call("pet:notices:set-system-rule", { origin: "user" })).toThrow();
    ipc.dispose();
  });
});
