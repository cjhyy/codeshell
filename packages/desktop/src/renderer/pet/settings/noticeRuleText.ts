import type { TFunction } from "../../i18n";
import type { PetNoticeRuleSummary, PetProactiveStatus } from "../../../shared/pet-notices";

/**
 * The rule list's wording, from each row's structured fields only. Titles
 * and schedule labels that Mimi wrote are shown as plain text, never parsed.
 */

export type RuleGroup = "sessions" | "followUps" | "proactive" | "ended";

const ENDED = new Set<PetNoticeRuleSummary["state"]>(["spent", "completed", "cancelled"]);

export function ruleGroup(rule: PetNoticeRuleSummary): RuleGroup {
  if (rule.source === "system") return "proactive";
  if (ENDED.has(rule.state)) return "ended";
  return rule.kind === "schedule" ? "followUps" : "sessions";
}

export function ruleTitle(rule: PetNoticeRuleSummary, t: TFunction): string {
  switch (rule.kind) {
    case "all-sessions":
      return t("mimiSettings.rules.title.allSessions");
    case "system-brief":
      return t(`mimiSettings.rules.title.${rule.brief ?? "morning"}`);
    case "system-heartbeat":
      return t("mimiSettings.rules.title.heartbeat");
    case "schedule":
      return rule.title ?? rule.sessionTitle ?? t("mimiSettings.rules.untitledSession");
    default:
      return rule.sessionTitle ?? t("mimiSettings.rules.untitledSession");
  }
}

/** Local date and time, short ("11月12日 09:00" / "Nov 12, 09:00"). */
export function ruleTime(ms: number, lang: string): string {
  return new Intl.DateTimeFormat(lang === "en" ? "en" : "zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
}

function eventsText(rule: PetNoticeRuleSummary, t: TFunction): string {
  return (rule.events ?? [])
    .map((event) => t(`mimiSettings.rules.event.${event}`))
    .join(t("mimiSettings.rules.eventSeparator"));
}

/** When it fires: events, a daily time, a window, or a schedule (Mimi's label or the instant). */
export function ruleWhen(rule: PetNoticeRuleSummary, t: TFunction, lang: string): string {
  switch (rule.kind) {
    case "session": {
      const text = t("mimiSettings.rules.when.session", { events: eventsText(rule, t) });
      return rule.scope === "goal"
        ? `${text}${t("mimiSettings.rules.eventSeparator")}${t("mimiSettings.rules.when.goal")}`
        : text;
    }
    case "all-sessions":
      return t("mimiSettings.rules.when.allSessions", { events: eventsText(rule, t) });
    case "system-brief":
      return t("mimiSettings.rules.when.daily", { time: rule.dailyAt ?? "" });
    case "system-heartbeat":
      return t("mimiSettings.rules.when.heartbeat", {
        start: rule.activeHours?.start ?? "",
        end: rule.activeHours?.end ?? "",
      });
    default: {
      const schedule = rule.schedule;
      const when =
        schedule?.label ??
        (schedule?.at !== undefined
          ? t("mimiSettings.rules.when.once", { time: ruleTime(schedule.at, lang) })
          : "");
      const what = t(
        rule.followUp === "continue"
          ? "mimiSettings.rules.when.continue"
          : "mimiSettings.rules.when.remind",
      );
      return when ? `${when}${t("mimiSettings.rules.eventSeparator")}${what}` : what;
    }
  }
}

export function ruleNext(
  rule: PetNoticeRuleSummary,
  t: TFunction,
  lang: string,
): string | undefined {
  const next = rule.schedule?.nextAt;
  return next === undefined
    ? undefined
    : t("mimiSettings.rules.when.next", { time: ruleTime(next, lang) });
}

/** The raw cron (a tooltip only, never the main text). */
export function ruleCronTitle(rule: PetNoticeRuleSummary, t: TFunction): string | undefined {
  const schedule = rule.schedule;
  return schedule?.cron
    ? t("mimiSettings.rules.when.cronTitle", { cron: schedule.cron, timezone: schedule.timezone })
    : undefined;
}

export function ruleTarget(rule: PetNoticeRuleSummary, t: TFunction): string {
  const target = rule.target;
  const notReady =
    "ready" in target && target.ready && target.ready !== "ready"
      ? t("mimiSettings.rules.target.notReady")
      : "";
  switch (target.kind) {
    case "desktop":
      return t("mimiSettings.rules.target.desktop");
    case "auto":
      return target.label
        ? t("mimiSettings.rules.target.auto", { channel: target.label }) + notReady
        : t("mimiSettings.rules.target.autoDesktop");
    case "channel":
      return t("mimiSettings.rules.target.channel", { channel: target.label }) + notReady;
    case "chat":
      return t(
        target.direct
          ? "mimiSettings.rules.target.chatDirect"
          : "mimiSettings.rules.target.chatGroup",
        { channel: target.label },
      );
  }
}

export function ruleLast(
  rule: PetNoticeRuleSummary,
  t: TFunction,
  lang: string,
): string | undefined {
  if (rule.lastFiredAt === undefined) return undefined;
  return t("mimiSettings.rules.last", {
    time: ruleTime(rule.lastFiredAt, lang),
    outcome: t(`mimiSettings.rules.outcome.${rule.lastOutcome ?? "notified"}`),
  });
}

export function heartbeatUsage(
  status: PetProactiveStatus | undefined,
  t: TFunction,
  key: "mimiSettings.rules.heartbeatUsage" | "mimiSettings.proactive.heartbeatUsage",
): string | undefined {
  if (!status) return undefined;
  const beat = status.heartbeat;
  return t(key, {
    judged: beat.judgedToday,
    judgeCap: beat.judgeCap,
    said: beat.saidToday,
    sayCap: beat.sayCap,
  });
}
