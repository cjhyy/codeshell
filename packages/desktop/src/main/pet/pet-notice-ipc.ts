import {
  NOTICE_CHANNEL_MAX_LENGTH,
  NOTICE_EVENTS,
  parseNoticeEvents,
} from "@cjhyy/code-shell-pet/protocol";
import type {
  PetNoticeChannel,
  PetNoticesState,
  PetNoticeSystemRule,
  PetNoticeSystemRulePatch,
  PetSessionBellState,
} from "../../shared/pet-notices.js";
import type { PetNoticeWiring } from "./pet-notice-wiring.js";
import { PetRuleStoreError, type NoticeRule } from "./pet-rule-store.js";

export const PET_NOTICES_GET_STATE_CHANNEL = "pet:notices:get-state";
export const PET_NOTICES_SESSION_BELL_CHANNEL = "pet:notices:session-bell";
export const PET_NOTICES_SET_SESSION_BELL_CHANNEL = "pet:notices:set-session-bell";
export const PET_NOTICES_SET_SYSTEM_RULE_CHANNEL = "pet:notices:set-system-rule";
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
    | "resolveRuleTarget"
    | "predictIm"
    | "isEligibleSession"
  >;
  ownerChannels(): readonly PetNoticeChannel[];
  /**
   * The Session's persisted Goal (SessionManager). An active, unpaused Goal
   * makes the bell wait for the Goal instead of the next turn.
   */
  goals: { readActiveGoal(sessionId: string): { paused?: boolean } | undefined };
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The Session's own rules with this origin (never the all-sessions system rule). */
function sessionRules(
  rules: readonly NoticeRule[],
  sessionId: string,
  origin: "user" | "delegation",
): NoticeRule[] {
  return rules.filter(
    (rule) =>
      rule.when.kind === "session" && rule.when.sessionId === sessionId && rule.origin === origin,
  );
}

const UNAVAILABLE: PetSessionBellState = { available: false, on: false, delegated: false };

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

  /** The owner's own rule speaks for the bell; Mimi's delegation rule alone is read-only. */
  const describe = (sessionId: string): PetSessionBellState => {
    const active = store.activeForSession(sessionId);
    const delegation = newest(sessionRules(active, sessionId, "delegation"));
    const user = newest(sessionRules(active, sessionId, "user"));
    const rule = user ?? delegation;
    if (!rule) return { available: true, on: false, delegated: false };
    const im = notices.predictIm(rule.channel, rule.target);
    return {
      available: true,
      on: true,
      origin: user ? "user" : "delegation",
      delegated: delegation !== undefined,
      ruleId: rule.id,
      channel: rule.channel,
      ...(im ? { imLabel: im.label, ready: im.ready } : {}),
    };
  };

  /** Cancel one rule; a concurrent write gets one retry against the fresh version. */
  const cancel = async (rule: NoticeRule): Promise<void> => {
    try {
      await store.update(rule.id, rule.version, { state: "cancelled" });
    } catch (error) {
      if (!(error instanceof PetRuleStoreError) || error.code !== "version_conflict") throw error;
      const fresh = store.get(rule.id);
      if (!fresh || fresh.state !== "active") return;
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

  return {
    async getState() {
      await notices.ready;
      return { channels: channels(), systemRule: systemRule(), settings: notices.settingsView() };
    },
    async sessionBell(sessionId) {
      await notices.ready;
      return notices.isEligibleSession(sessionId) ? describe(sessionId) : UNAVAILABLE;
    },
    async setSessionBell(sessionId, on) {
      await notices.ready;
      if (!notices.isEligibleSession(sessionId)) return UNAVAILABLE;
      if (on) {
        const target = await notices.resolveRuleTarget(sessionId);
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
        // Only the owner's own rules: Mimi's delegation rule follows its task, not the bell.
        for (const rule of sessionRules(store.activeForSession(sessionId), sessionId, "user")) {
          await cancel(rule);
        }
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

/** Notice-rule IPC: the Session bell, the system rule and the settings card's state. */
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
  options.ipcMain.handle(PET_NOTICES_SET_SYSTEM_RULE_CHANNEL, (_event, ...args) => {
    if (args.length !== 1) throw new Error("invalid system notice rule patch");
    return controls.setSystemRule(parseSystemRulePatch(args[0]));
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
    options.ipcMain.removeHandler(PET_NOTICES_SET_SYSTEM_RULE_CHANNEL);
  };
}
