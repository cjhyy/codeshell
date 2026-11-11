import type {
  PetNoticeChannel,
  PetNoticeRuleAction,
  PetNoticeRuleSource,
  PetNoticeRuleSummary,
  PetNoticeRuleTarget,
  PetNoticeRuleUpdate,
  PetNoticeRuleUpdateResult,
  PetNotificationSettingsView,
} from "../../shared/pet-notices.js";
import { PET_NOTICE_ENDED_RULES_LIMIT } from "../../shared/pet-notices.js";
import { DEFAULT_ACTIVE_HOURS, DEFAULT_BRIEF_TIMES } from "./pet-notice-settings.js";
import {
  isScheduleRule,
  isSystemScheduleRule,
  PetRuleStoreError,
  type EventNoticeRule,
  type NoticeRule,
  type PetRuleStore,
  type ScheduleNoticeRule,
  type SystemScheduleRuleId,
} from "./pet-rule-store.js";
import { dueAt } from "./pet-schedule-rule.js";

/**
 * The rule list (design §4, §11; phase 2d-2): every trigger that can fire,
 * as display rows, and the owner's pause / resume / cancel on them. Rows are
 * built from structured rule fields only (who created it, when, then,
 * target, state, the last occurrence); nothing here reads prose.
 */

const SYSTEM_RULE_ID = "all-sessions";
/** Mimi's own schedule rules the list shows; the heartbeat's one-off recheck is part of the heartbeat. */
const LISTED_SYSTEM_SCHEDULES = [
  "system-brief-morning",
  "system-brief-evening",
  "system-heartbeat",
] as const satisfies readonly SystemScheduleRuleId[];
type ListedSystemSchedule = (typeof LISTED_SYSTEM_SCHEDULES)[number];
const ENDED: ReadonlySet<NoticeRule["state"]> = new Set(["spent", "completed", "cancelled"]);

export interface NoticeRuleListSource {
  rules: Pick<PetRuleStore, "list" | "systemRule">;
  /** `pet.notifications` with defaults: the source of truth for briefs and the heartbeat. */
  settings(): PetNotificationSettingsView;
  channels(): readonly PetNoticeChannel[];
  /** The IM a rule is predicted to use (`PetNoticeWiring.predictIm`); undefined → desktop. */
  predictIm(
    channel: string,
    target: NoticeRule["target"],
  ): { label: string; ready: PetNoticeChannel["ready"] } | undefined;
  sessionTitle(sessionId: string): string | undefined;
}

function isListedSystemSchedule(id: string): id is ListedSystemSchedule {
  return (LISTED_SYSTEM_SCHEDULES as readonly string[]).includes(id);
}

function sourceOf(rule: NoticeRule): PetNoticeRuleSource {
  switch (rule.createdBy) {
    case "notify-me":
    case "bell":
      return "owner";
    case "delegation":
      return "delegation";
    case "watch-session":
      return "watch";
    case "follow-up":
      return "follow-up";
    default:
      return "system";
  }
}

function targetOf(rule: NoticeRule, source: NoticeRuleListSource): PetNoticeRuleTarget {
  const label = (id: string) => source.channels().find((channel) => channel.id === id)?.label ?? id;
  if (rule.target.kind === "route")
    // The conversation itself (its target / sender ids) never leaves main.
    return {
      kind: "chat",
      label: label(rule.target.route.channel),
      direct: rule.target.route.isDirectMessage === true,
    };
  if (rule.channel === "desktop") return { kind: "desktop" };
  const im = source.predictIm(rule.channel, rule.target);
  if (rule.channel === "auto")
    return { kind: "auto", ...(im ? { label: im.label, ready: im.ready } : {}) };
  return {
    kind: "channel",
    label: im?.label ?? label(rule.channel),
    ...(im ? { ready: im.ready } : {}),
  };
}

/** When a schedule rule last fired and how: the settled occurrence, or the one before it. */
function lastFired(
  rule: ScheduleNoticeRule,
): Pick<PetNoticeRuleSummary, "lastFiredAt" | "lastOutcome"> {
  const { wake } = rule;
  if (wake.completedAt !== undefined && wake.status !== "scheduled" && wake.status !== "claimed")
    return { lastFiredAt: wake.completedAt, lastOutcome: wake.status };
  return wake.previous
    ? { lastFiredAt: wake.previous.completedAt, lastOutcome: wake.previous.status }
    : {};
}

function nextAt(rule: ScheduleNoticeRule): number | undefined {
  return rule.state === "active" && rule.wake.status === "scheduled" ? dueAt(rule.wake) : undefined;
}

function liveActions(state: NoticeRule["state"]): PetNoticeRuleAction[] {
  if (state === "active") return ["pause", "cancel"];
  if (state === "paused") return ["resume", "cancel"];
  return [];
}

function summarizeRule(
  rule: NoticeRule,
  source: NoticeRuleListSource,
): PetNoticeRuleSummary | undefined {
  const base = {
    id: rule.id,
    version: rule.version,
    state: rule.state,
    source: sourceOf(rule),
    target: targetOf(rule, source),
    actions: liveActions(rule.state),
    updatedAt: rule.updatedAt,
  };
  if (rule.when.kind === "session") {
    const title = source.sessionTitle(rule.when.sessionId);
    return {
      ...base,
      kind: "session",
      sessionId: rule.when.sessionId,
      ...(title ? { sessionTitle: title } : {}),
      events: [...rule.when.events],
      scope: rule.when.scope,
      // A Session rule is spent by the outcome it told about (or its task's end).
      ...(rule.state === "spent" ? { lastFiredAt: rule.updatedAt } : {}),
    };
  }
  if (!isScheduleRule(rule) || isSystemScheduleRule(rule)) return undefined;
  const then = rule.then;
  if (then.mode !== "remind" && then.mode !== "run-mimi") return undefined;
  const continues = then.mode === "run-mimi" ? then.sourceSessionId : undefined;
  const title = continues ? source.sessionTitle(continues) : undefined;
  const next = nextAt(rule);
  // A one-shot that already fired waits on the follow-up list; it can only be cancelled.
  const fired = rule.when.at !== undefined && rule.wake.status !== "scheduled";
  return {
    ...base,
    kind: "schedule",
    title: then.title,
    followUp: continues ? "continue" : "remind",
    ...(continues ? { sessionId: continues } : {}),
    ...(title ? { sessionTitle: title } : {}),
    schedule: {
      ...(rule.when.at !== undefined ? { at: rule.when.at } : {}),
      ...(rule.when.cron !== undefined ? { cron: rule.when.cron } : {}),
      ...(rule.when.label !== undefined ? { label: rule.when.label } : {}),
      timezone: rule.when.timezone,
      ...(next !== undefined ? { nextAt: next } : {}),
    },
    ...lastFired(rule),
    actions: fired && rule.state === "active" ? ["cancel"] : base.actions,
  };
}

function allSessionsSummary(
  rule: EventNoticeRule,
  source: NoticeRuleListSource,
): PetNoticeRuleSummary {
  const on = rule.state === "active";
  return {
    id: SYSTEM_RULE_ID,
    version: rule.version,
    kind: "all-sessions",
    state: on ? "active" : "paused",
    source: "system",
    events: [...rule.when.events],
    target: targetOf(rule, source),
    actions: [on ? "pause" : "resume"],
    updatedAt: rule.updatedAt,
  };
}

/** A brief or the heartbeat: on/off and times from the settings, progress from its rule row. */
function systemScheduleSummary(
  id: ListedSystemSchedule,
  rule: NoticeRule | undefined,
  settings: PetNotificationSettingsView,
  source: NoticeRuleListSource,
): PetNoticeRuleSummary {
  const brief =
    id === "system-brief-morning"
      ? "morning"
      : id === "system-brief-evening"
        ? "evening"
        : undefined;
  const enabled = brief
    ? settings.briefs?.[brief].enabled === true
    : settings.heartbeat?.enabled === true;
  const scheduled = rule && isSystemScheduleRule(rule) ? rule : undefined;
  const next = scheduled && enabled ? nextAt(scheduled) : undefined;
  const owner: NoticeRule["target"] = { kind: "owner" };
  const im = source.predictIm("auto", owner);
  return {
    id,
    version: rule?.version ?? 0,
    kind: brief ? "system-brief" : "system-heartbeat",
    state: enabled ? "active" : "paused",
    source: "system",
    ...(brief
      ? {
          brief,
          dailyAt: settings.briefs?.[brief].time ?? DEFAULT_BRIEF_TIMES[brief],
        }
      : { activeHours: { ...(settings.heartbeat?.activeHours ?? DEFAULT_ACTIVE_HOURS) } }),
    ...(scheduled
      ? {
          schedule: {
            ...(scheduled.when.cron !== undefined ? { cron: scheduled.when.cron } : {}),
            timezone: scheduled.when.timezone,
            ...(next !== undefined ? { nextAt: next } : {}),
          },
          ...lastFired(scheduled),
        }
      : {}),
    target: { kind: "auto", ...(im ? { label: im.label, ready: im.ready } : {}) },
    actions: [enabled ? "pause" : "resume"],
    updatedAt: rule?.updatedAt ?? 0,
  };
}

const newestFirst = (a: NoticeRule, b: NoticeRule) =>
  b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);

/**
 * Every row of the list: Mimi's system rules (always, even never switched
 * on), then live rules newest first, then the last few ended ones.
 */
export function noticeRuleSummaries(source: NoticeRuleListSource): PetNoticeRuleSummary[] {
  const all = source.rules.list();
  const byId = new Map(all.map((rule) => [rule.id, rule]));
  const settings = source.settings();
  const system: PetNoticeRuleSummary[] = [
    allSessionsSummary(source.rules.systemRule("all-sessions"), source),
    ...LISTED_SYSTEM_SCHEDULES.map((id) =>
      systemScheduleSummary(id, byId.get(id), settings, source),
    ),
  ];
  const owned = all.filter((rule) => rule.origin !== "system").sort(newestFirst);
  const summarize = (rules: NoticeRule[]) =>
    rules.flatMap((rule) => summarizeRule(rule, source) ?? []);
  return [
    ...system,
    ...summarize(owned.filter((rule) => !ENDED.has(rule.state))),
    ...summarize(owned.filter((rule) => ENDED.has(rule.state))).slice(
      0,
      PET_NOTICE_ENDED_RULES_LIMIT,
    ),
  ];
}

/** The owner's partial `pet.notifications` write (deep-merged into user settings). */
export type NotificationSettingsWrite = (notifications: Record<string, unknown>) => Promise<void>;

export interface NoticeRuleUpdaterDeps extends NoticeRuleListSource {
  rules: Pick<PetRuleStore, "list" | "systemRule" | "get" | "update" | "setSystemRule">;
  /** Briefs and the heartbeat are switched in the settings; main then syncs their rules. */
  writeNotificationSettings?: NotificationSettingsWrite;
  /** The follow-up control's cancel (`pet:follow-up-control`), so both paths stay one. */
  cancelFollowUp?(followUpId: string, expectedRevision: number): Promise<unknown>;
}

const STATE_FOR: Record<PetNoticeRuleAction, NoticeRule["state"]> = {
  pause: "paused",
  resume: "active",
  cancel: "cancelled",
};

function storeErrorCode(error: unknown): string | undefined {
  if (error instanceof PetRuleStoreError) return error.code;
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof PetRuleStoreError ? cause.code : undefined;
}

function settingsPatchFor(id: ListedSystemSchedule, on: boolean): Record<string, unknown> {
  if (id === "system-heartbeat") return { heartbeat: { enabled: on } };
  return { briefs: { [id === "system-brief-morning" ? "morning" : "evening"]: { enabled: on } } };
}

/**
 * Pause, resume or cancel one listed rule with optimistic concurrency:
 * `expectedVersion` is the version the owner saw. Mimi's own rules only
 * pause and resume (the briefs and heartbeat through the settings, the
 * every-Session rule through its system-rule path); the owner's and
 * delegation rules are changed in the rule store; a follow-up is cancelled
 * through the follow-up control. Refusals come back as results, not throws.
 */
export async function updateNoticeRule(
  deps: NoticeRuleUpdaterDeps,
  request: PetNoticeRuleUpdate,
): Promise<PetNoticeRuleUpdateResult> {
  const summary = (id: string) => noticeRuleSummaries(deps).find((row) => row.id === id);
  const refused = (
    reason: "version_conflict" | "not_found" | "not_allowed",
  ): PetNoticeRuleUpdateResult => {
    const rule = summary(request.ruleId);
    return { ok: false, reason, ...(rule ? { rule } : {}) };
  };
  const current = summary(request.ruleId);
  if (!current) return refused("not_found");
  if (current.version !== request.expectedVersion) return refused("version_conflict");
  if (!current.actions.includes(request.action)) return refused("not_allowed");
  const on = request.action === "resume";
  try {
    if (current.kind === "all-sessions") {
      await deps.rules.setSystemRule("all-sessions", { state: on ? "active" : "paused" });
    } else if (isListedSystemSchedule(current.id)) {
      if (!deps.writeNotificationSettings) throw new Error("notification settings are read-only");
      // Settings are the source of truth; writing them re-syncs the rule.
      await deps.writeNotificationSettings(settingsPatchFor(current.id, on));
    } else if (current.kind === "schedule" && request.action === "cancel" && deps.cancelFollowUp) {
      await deps.cancelFollowUp(current.id, current.version);
    } else {
      await deps.rules.update(current.id, current.version, { state: STATE_FOR[request.action] });
    }
  } catch (error) {
    const code = storeErrorCode(error);
    if (code === "version_conflict") return refused("version_conflict");
    if (code === "rule_not_found") return refused("not_found");
    if (code === "duplicate_active_rule" || code === "invalid_rule") return refused("not_allowed");
    throw error;
  }
  const rule = summary(request.ruleId);
  return { ok: true, ...(rule ? { rule } : {}) };
}
