import {
  NOTICE_CHANNEL_MAX_LENGTH,
  NOTICE_EVENTS,
  parseNoticeEvents,
} from "@cjhyy/code-shell-pet/protocol";
import type {
  PetNoticeChannel,
  PetNoticeRuleAction,
  PetNoticeRuleUpdate,
  PetNoticeRuleUpdateResult,
  PetNoticesState,
  PetProactiveStatus,
  PetNoticeSystemRule,
  PetNoticeSystemRulePatch,
  PetSessionBellState,
} from "../../shared/pet-notices.js";
import {
  noticeRuleSummaries,
  updateNoticeRule,
  type NoticeRuleUpdaterDeps,
  type NotificationSettingsWrite,
} from "./pet-notice-rule-list.js";
import type { PetNoticeWiring } from "./pet-notice-wiring.js";
import { PetRuleStoreError, type NoticeRule } from "./pet-rule-store.js";

export const PET_NOTICES_GET_STATE_CHANNEL = "pet:notices:get-state";
export const PET_NOTICES_SESSION_BELL_CHANNEL = "pet:notices:session-bell";
export const PET_NOTICES_SET_SESSION_BELL_CHANNEL = "pet:notices:set-session-bell";
/**
 * The one rule mutation channel: the every-Session rule's patch (its
 * original payload, still accepted) or `{ ruleId, expectedVersion, action }`
 * for any listed rule (design §11, phase 2d-2). It replaced
 * `pet:notices:set-system-rule` without adding a route.
 */
export const PET_NOTICES_UPDATE_RULE_CHANNEL = "pet:notices:update-rule";
export const PET_NOTICES_CHANGED_CHANNEL = "pet:notices:changed";

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const MAX_CHANNELS = 32;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

/** What the renderer can see and change about notice rules. */
export interface PetNoticeControls {
  getState(): Promise<PetNoticesState>;
  sessionBell(sessionId: string): Promise<PetSessionBellState>;
  setSessionBell(sessionId: string, on: boolean): Promise<PetSessionBellState>;
  setSystemRule(patch: PetNoticeSystemRulePatch): Promise<PetNoticeSystemRule>;
  /** Pause, resume or cancel one listed rule (optimistic: `expectedVersion`). */
  updateRule(request: PetNoticeRuleUpdate): Promise<PetNoticeRuleUpdateResult>;
  /** Rules or notification settings changed; bells and the settings card refetch. */
  subscribe(listener: () => void): () => void;
}

export interface PetNoticeControlsDeps {
  notices: Pick<
    PetNoticeWiring,
    | "ruleStore"
    | "ready"
    | "settingsView"
    | "onSettingsChange"
    | "deliveries"
    | "predictIm"
    | "isEligibleSession"
    | "sessionTitle"
  >;
  ownerChannels(): readonly PetNoticeChannel[];
  /**
   * The Session's persisted Goal (SessionManager). An active, unpaused Goal
   * makes the bell wait for the Goal instead of the next turn.
   */
  goals: { readActiveGoal(sessionId: string): { paused?: boolean } | undefined };
  /** Briefs' and heartbeat's state today (counts at their caps), once they run. */
  proactive?: () => PetProactiveStatus | undefined;
  /** Writes `pet.notifications` (briefs / heartbeat switches from the rule list). */
  writeNotificationSettings?: NotificationSettingsWrite;
  /** The follow-up control's cancel, used when the list cancels a follow-up. */
  cancelFollowUp?: NoticeRuleUpdaterDeps["cancelFollowUp"];
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

type BellSource = "owner" | "delegation" | "watch";

/**
 * Who set a Session rule up, from its structured fields: an IM chat's watch
 * is stored as the owner's ask (origin "user") but is not the bell's own.
 */
function bellSource(rule: NoticeRule): BellSource {
  if (rule.origin === "delegation") return "delegation";
  return rule.createdBy === "watch-session" ? "watch" : "owner";
}

/** The Session's own rules from this source (never the all-sessions system rule). */
function sessionRules(
  rules: readonly NoticeRule[],
  sessionId: string,
  source: BellSource,
): NoticeRule[] {
  return rules.filter(
    (rule) =>
      rule.when.kind === "session" &&
      rule.when.sessionId === sessionId &&
      bellSource(rule) === source,
  );
}

const BELL_SOURCES: readonly BellSource[] = ["owner", "delegation", "watch"];
const RULE_ACTIONS: readonly PetNoticeRuleAction[] = ["pause", "resume", "cancel"];

const UNAVAILABLE: PetSessionBellState = { available: false, on: false, delegated: false };
/** How long after a Session rule fired the renderer leaves its outcome to main. */
const FIRED_RECENTLY_MS = 60_000;

export function createPetNoticeControls(deps: PetNoticeControlsDeps): PetNoticeControls {
  const { notices } = deps;
  const now = deps.now ?? Date.now;
  const store = notices.ruleStore;

  const channels = (): PetNoticeChannel[] =>
    deps
      .ownerChannels()
      .slice(0, MAX_CHANNELS)
      .map(({ id, label, ready }) => ({ id, label, ready }));

  const goalActive = (sessionId: string): boolean => {
    try {
      const goal = deps.goals.readActiveGoal(sessionId);
      return goal !== undefined && goal.paused !== true;
    } catch {
      return false;
    }
  };

  const newest = (rules: readonly NoticeRule[]): NoticeRule | undefined =>
    [...rules].sort((a, b) => b.updatedAt - a.updatedAt)[0];

  /**
   * The owner's own rule speaks for the bell; Mimi's delegation rule, or an
   * IM chat's watch, alone is read-only.
   */
  const describe = (sessionId: string): PetSessionBellState => {
    const active = store.activeForSession(sessionId);
    const delegation = newest(sessionRules(active, sessionId, "delegation"));
    const user = newest(sessionRules(active, sessionId, "owner"));
    const watch = newest(sessionRules(active, sessionId, "watch"));
    const rule = user ?? delegation ?? watch;
    const sources = BELL_SOURCES.filter(
      (source) => sessionRules(active, sessionId, source).length > 0,
    );
    const since = now() - FIRED_RECENTLY_MS;
    const fired = store
      .list()
      .some(
        (candidate) =>
          candidate.when.kind === "session" &&
          candidate.when.sessionId === sessionId &&
          candidate.state === "spent" &&
          candidate.updatedAt >= since,
      );
    if (!rule)
      return {
        available: true,
        on: false,
        delegated: false,
        ...(fired ? { firedRecently: true } : {}),
      };
    const im = notices.predictIm(rule.channel, rule.target);
    const watchesDone = active.some(
      (candidate) => candidate.when.kind === "session" && candidate.when.events.includes("done"),
    );
    return {
      available: true,
      on: true,
      origin: user ? "user" : delegation ? "delegation" : "watch",
      sources,
      delegated: delegation !== undefined,
      ruleId: rule.id,
      channel: rule.channel,
      ...(im ? { imLabel: im.label, ready: im.ready } : {}),
      ...(watchesDone ? { watchesDone: true } : {}),
      ...(fired ? { firedRecently: true } : {}),
    };
  };

  /** Cancel one rule; a concurrent write gets one retry against the fresh version. */
  const cancel = async (rule: NoticeRule): Promise<void> => {
    try {
      await store.update(rule.id, rule.version, { state: "cancelled" });
    } catch (error) {
      if (!(error instanceof PetRuleStoreError) || error.code !== "version_conflict") throw error;
      const fresh = store.get(rule.id);
      if (!fresh || (fresh.state !== "active" && fresh.state !== "paused")) return;
      await store.update(fresh.id, fresh.version, { state: "cancelled" });
    }
  };

  const systemRule = (): PetNoticeSystemRule => {
    const rule = store.systemRule("all-sessions");
    return {
      state: rule.state === "active" ? "active" : "paused",
      channel: rule.channel,
      events: [...rule.when.events],
    };
  };

  const listSource: NoticeRuleUpdaterDeps = {
    rules: store,
    settings: () => notices.settingsView(),
    channels,
    predictIm: (channel, target) => notices.predictIm(channel, target),
    sessionTitle: (sessionId) => notices.sessionTitle(sessionId),
    now,
    ...(deps.writeNotificationSettings
      ? { writeNotificationSettings: deps.writeNotificationSettings }
      : {}),
    ...(deps.cancelFollowUp ? { cancelFollowUp: deps.cancelFollowUp } : {}),
  };

  return {
    async getState() {
      await notices.ready;
      let proactive: PetProactiveStatus | undefined;
      try {
        proactive = deps.proactive?.();
      } catch {
        proactive = undefined;
      }
      return {
        channels: channels(),
        systemRule: systemRule(),
        settings: notices.settingsView(),
        ...(proactive ? { proactive } : {}),
        rules: noticeRuleSummaries(listSource),
      };
    },
    async updateRule(request) {
      await notices.ready;
      return updateNoticeRule(listSource, request);
    },
    async sessionBell(sessionId) {
      await notices.ready;
      return notices.isEligibleSession(sessionId) ? describe(sessionId) : UNAVAILABLE;
    },
    async setSessionBell(sessionId, on) {
      await notices.ready;
      if (!notices.isEligibleSession(sessionId)) return UNAVAILABLE;
      if (on) {
        const target = await notices.deliveries.ruleTarget(sessionId);
        await store.upsertSessionRule({
          sessionId,
          createdBy: "bell",
          events: [...NOTICE_EVENTS],
          scope: goalActive(sessionId) ? "goal" : "turn",
          channel: "auto",
          attention: "always",
          target,
          origin: "user",
          armedAt: now(),
        });
      } else {
        // Only the owner's own rules: Mimi's delegation rule follows its task, and
        // an IM chat's watch is that chat's (both are managed in the rule list).
        // Paused ones too: the bell is off, so they must not pile up to be resumed.
        const owned = sessionRules(store.list(), sessionId, "owner").filter(
          (rule) => rule.state === "active" || rule.state === "paused",
        );
        for (const rule of owned) await cancel(rule);
      }
      return describe(sessionId);
    },
    async setSystemRule(patch) {
      await notices.ready;
      if (
        patch.channel !== undefined &&
        patch.channel !== "auto" &&
        patch.channel !== "desktop" &&
        !channels().some((channel) => channel.id === patch.channel)
      )
        throw new Error("unknown notice channel");
      await store.setSystemRule("all-sessions", {
        ...(patch.state !== undefined ? { state: patch.state } : {}),
        ...(patch.channel !== undefined ? { channel: patch.channel } : {}),
        ...(patch.events !== undefined ? { events: [...patch.events] } : {}),
      });
      return systemRule();
    },
    subscribe(listener) {
      const offRules = store.onChange(listener);
      const offSettings = notices.onSettingsChange(listener);
      return () => {
        offRules();
        offSettings();
      };
    },
  };
}

function parseSessionId(value: unknown, message: string): string {
  if (typeof value !== "string" || !SESSION_ID.test(value)) throw new Error(message);
  return value;
}

function parseSessionBellRequest(value: unknown): { sessionId: string; on: boolean } {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "sessionId" && key !== "on") ||
    typeof value.on !== "boolean"
  )
    throw new Error("invalid session bell request");
  return {
    sessionId: parseSessionId(value.sessionId, "invalid session bell request"),
    on: value.on,
  };
}

const RULE_ID = /^[A-Za-z0-9_-]{1,128}$/u;

function parseRuleUpdate(value: Record<string, unknown>): PetNoticeRuleUpdate {
  if (
    Object.keys(value).some((key) => !["ruleId", "expectedVersion", "action"].includes(key)) ||
    typeof value.ruleId !== "string" ||
    !RULE_ID.test(value.ruleId) ||
    typeof value.expectedVersion !== "number" ||
    !Number.isSafeInteger(value.expectedVersion) ||
    value.expectedVersion < 0 ||
    !(RULE_ACTIONS as readonly unknown[]).includes(value.action)
  )
    throw new Error("invalid notice rule update");
  return {
    ruleId: value.ruleId,
    expectedVersion: value.expectedVersion,
    action: value.action as PetNoticeRuleAction,
  };
}

function parseSystemRulePatch(value: unknown): PetNoticeSystemRulePatch {
  const invalid = (): never => {
    throw new Error("invalid system notice rule patch");
  };
  if (!isRecord(value)) return invalid();
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !["state", "channel", "events"].includes(key)))
    return invalid();
  const patch: PetNoticeSystemRulePatch = {};
  if (value.state !== undefined) {
    if (value.state !== "active" && value.state !== "paused") return invalid();
    patch.state = value.state;
  }
  if (value.channel !== undefined) {
    if (
      typeof value.channel !== "string" ||
      !value.channel ||
      value.channel.length > NOTICE_CHANNEL_MAX_LENGTH ||
      value.channel.trim() !== value.channel ||
      CONTROL_CHARS.test(value.channel)
    )
      return invalid();
    patch.channel = value.channel;
  }
  if (value.events !== undefined) {
    const events = parseNoticeEvents(value.events);
    if (!events) return invalid();
    patch.events = events;
  }
  return patch;
}

export interface PetNoticeIpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): unknown;
  removeHandler(channel: string): unknown;
}

export interface PetNoticeIpcWindowLike {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: unknown): void };
}

/** Notice-rule IPC: the Session bell, rule changes and the settings cards' state. */
export function registerPetNoticeIpc(options: {
  ipcMain: PetNoticeIpcMainLike;
  windows: () => readonly PetNoticeIpcWindowLike[];
  controls: PetNoticeControls;
}): () => void {
  const { controls } = options;
  options.ipcMain.handle(PET_NOTICES_GET_STATE_CHANNEL, (_event, ...args) => {
    if (args.length !== 0) throw new Error("pet notices state does not accept arguments");
    return controls.getState();
  });
  options.ipcMain.handle(PET_NOTICES_SESSION_BELL_CHANNEL, (_event, ...args) => {
    if (args.length !== 1) throw new Error("invalid session bell query");
    return controls.sessionBell(parseSessionId(args[0], "invalid session bell query"));
  });
  options.ipcMain.handle(PET_NOTICES_SET_SESSION_BELL_CHANNEL, (_event, ...args) => {
    if (args.length !== 1) throw new Error("invalid session bell request");
    const request = parseSessionBellRequest(args[0]);
    return controls.setSessionBell(request.sessionId, request.on);
  });
  options.ipcMain.handle(PET_NOTICES_UPDATE_RULE_CHANNEL, (_event, ...args) => {
    if (args.length !== 1) throw new Error("invalid notice rule update");
    const payload = args[0];
    // A listed rule's action, or the every-Session rule's original patch.
    if (isRecord(payload) && "ruleId" in payload)
      return controls.updateRule(parseRuleUpdate(payload));
    return controls.setSystemRule(parseSystemRulePatch(payload));
  });
  const unsubscribe = controls.subscribe(() => {
    for (const window of options.windows()) {
      if (!window.isDestroyed()) window.webContents.send(PET_NOTICES_CHANGED_CHANNEL, null);
    }
  });
  return () => {
    unsubscribe();
    options.ipcMain.removeHandler(PET_NOTICES_GET_STATE_CHANNEL);
    options.ipcMain.removeHandler(PET_NOTICES_SESSION_BELL_CHANNEL);
    options.ipcMain.removeHandler(PET_NOTICES_SET_SESSION_BELL_CHANNEL);
    options.ipcMain.removeHandler(PET_NOTICES_UPDATE_RULE_CHANNEL);
  };
}
