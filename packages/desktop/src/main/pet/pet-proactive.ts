import type { PetLongTask } from "@cjhyy/code-shell-pet";
import type { PetProactiveStatus } from "../../shared/pet-notices.js";
import { isFollowUpRule } from "./pet-follow-up-rules.js";
import type { NoticeRecord } from "./pet-notice-ledger.js";
import { hostTimezoneOffsetMin, isInQuietHours, type RouteDecision } from "./pet-notice-policy.js";
import type { ProactiveModelSource } from "./pet-proactive-models.js";
import type { PetNotificationSettings } from "./pet-notice-settings.js";
import type { NoticeSubmission } from "./pet-notice-types.js";
import { briefName, collectBrief, writeBrief } from "./pet-proactive-brief.js";
import {
  heartbeatPrecheck,
  judgeHeartbeat,
  type HeartbeatFact,
} from "./pet-proactive-heartbeat.js";
import {
  HEARTBEAT_INTERVAL_MIN,
  hostTimezone,
  inClockWindow,
  syncSystemSchedules,
} from "./pet-proactive-rules.js";
import {
  HEARTBEAT_JUDGE_CAP,
  HEARTBEAT_SAY_CAP,
  heartbeatToday,
  localDayIndex,
  localDayStart,
  type BriefKind,
  type PetProactiveStateStore,
} from "./pet-proactive-state.js";
import type { RuleScheduleDue } from "./pet-rule-schedule.js";
import type { PetRuleStore, SystemScheduleNoticeRule } from "./pet-rule-store.js";
import { dueAt, type RuleWakeOutcome } from "./pet-schedule-rule.js";
import type { DesktopPendingDecision, DesktopPetSession } from "./pet-state-aggregator.js";

/**
 * Mimi's proactive rules at work (design §10): the brief and heartbeat
 * occurrences the rule scheduler hands over, and keeping the system rules in
 * line with the settings. Every message goes through the notice router
 * (quiet hours, caps, digest, channel, pending queue), addressed to the owner.
 */

const MINUTE = 60_000;
/** How far back a heartbeat looks at most. */
const HEARTBEAT_LOOKBACK_MS = 2 * 60 * MINUTE;
const NOTICE_SUMMARY_MAX = 600;

export interface PetProactiveDeps {
  rules: Pick<
    PetRuleStore,
    "load" | "list" | "get" | "update" | "setSystemSchedule" | "activeForSession"
  >;
  state: PetProactiveStateStore;
  ledger: {
    load(): Promise<void>;
    changedSince(ms: number): NoticeRecord[];
    actionRecords(): NoticeRecord[];
  };
  tasks(): readonly PetLongTask[];
  sessions(): readonly DesktopPetSession[];
  pending(): readonly DesktopPendingDecision[];
  wasSessionViewedSince(sessionId: string, ms: number): boolean;
  settings(): PetNotificationSettings;
  onSettingsChange(listener: () => void): () => void;
  /** The notice router (`PetNoticeWiring.submitNotice`). */
  submit(notice: NoticeSubmission): Promise<RouteDecision>;
  /** Snapshot the effective provider for each question; native selections use auxiliary → main. */
  models: ProactiveModelSource;
  now?: () => number;
  timezoneOffsetMin?: (ms: number) => number;
  timezone?: () => string;
  modelTimeoutMs?: number;
  log(event: string, data: Record<string, unknown>): void;
}

export interface PetProactive {
  /** Carry out one claimed occurrence of a system schedule rule. */
  fire(rule: SystemScheduleNoticeRule, due: RuleScheduleDue): Promise<RuleWakeOutcome>;
  /** Write the system rules from the current settings (also on every settings change). */
  sync(): Promise<void>;
  start(): Promise<void>;
  status(): PetProactiveStatus;
  dispose(): void;
}

function outcome(detail: string, status: RuleWakeOutcome["status"] = "notified"): RuleWakeOutcome {
  return { status, detail };
}

export function createPetProactive(deps: PetProactiveDeps): PetProactive {
  const now = deps.now ?? Date.now;
  const offset = deps.timezoneOffsetMin ?? hostTimezoneOffsetMin;
  const timezone = deps.timezone ?? hostTimezone;
  let unsubscribe: (() => void) | undefined;
  let syncing: Promise<void> = Promise.resolve();
  const onError = (event: string) => (error: unknown) =>
    deps.log(event, { error: error instanceof Error ? error.message : String(error) });

  const followUps = () => deps.rules.list().filter(isFollowUpRule);

  async function brief(kind: BriefKind, rule: SystemScheduleNoticeRule, due: RuleScheduleDue) {
    const name = briefName(kind);
    const settings = deps.settings();
    if (!settings.briefs[kind].enabled) return outcome(`${name}已关闭，未发送。`);
    const at = now();
    const zone = offset(at);
    const today = localDayIndex(at, zone);
    // Caught up after a sleep only on the day it was due.
    if (localDayIndex(due.occurrence, offset(due.occurrence)) !== today)
      return outcome(`错过了当天的${name}，未补发。`, "failed");
    await deps.state.load();
    const mark = deps.state.get().briefs[kind];
    if (mark?.day === today) return outcome(`今天的${name}已经发过，未重复发送。`);
    await deps.ledger.load();
    const todayStart = localDayStart(today, zone);
    const facts = collectBrief(
      kind,
      {
        since: mark?.sentAt ?? localDayStart(today - 1, zone),
        now: at,
        todayStart,
        tomorrowStart: localDayStart(today + 1, zone),
        dayAfterStart: localDayStart(today + 2, zone),
      },
      {
        tasks: deps.tasks(),
        sessions: deps.sessions(),
        pending: deps.pending(),
        followUps: followUps(),
        items: deps.ledger.actionRecords(),
      },
    );
    if (!facts) return outcome(`没有需要汇报的事，${name}未发送。`);
    const written = await writeBrief(
      facts,
      deps.models,
      { now: at, offsetMin: offset },
      {
        ...(deps.modelTimeoutMs !== undefined ? { timeoutMs: deps.modelTimeoutMs } : {}),
        onError: onError("pet.proactive.brief_model_failed"),
      },
    );
    const decision = await deps.submit({
      kind: `brief.${kind}`,
      priority: "P1",
      // One per local day: a retimed or caught-up brief never goes out twice.
      dedupeKey: `brief:${kind}:${today}`,
      ruleIds: [rule.id],
      facts: {
        title: name,
        summary: written.text.slice(0, NOTICE_SUMMARY_MAX),
        // What each line pointed at, so Mimi can later say what the brief said (Notices).
        refs: facts.records.map(({ ref, type, status, title, sessionId }) => ({
          ref,
          type,
          status,
          title,
          ...(sessionId ? { sessionId } : {}),
        })),
      },
      body: written.text,
      attention: "always",
      channel: "auto",
      target: { kind: "owner" },
      // "现在别说，明早再说": the owner may put it off.
      actions: { family: "notice" },
    });
    if (decision.outlet === "drop") {
      if (decision.reason === "duplicate") return outcome(`今天的${name}已经发过，未重复发送。`);
      // Not sent (the router was shutting down): not marked, so it may still go today.
      return outcome(`${name}未发出（${decision.reason}）。`, "failed");
    }
    await deps.state.update((draft) => {
      draft.briefs[kind] = { sentAt: at, day: today };
    });
    deps.log("pet.proactive.brief_sent", {
      kind,
      records: facts.records.length,
      by: written.by,
      outlet: decision.outlet,
    });
    return outcome(`已发送${name}（${facts.records.length} 项，${decision.reason}）。`);
  }

  /** The one extra look a judgement asked for; never more than one pending. */
  async function armRecheck(minutes: number, at: number): Promise<boolean> {
    const settings = deps.settings();
    const when = at + minutes * MINUTE;
    if (!inClockWindow(settings.heartbeat.activeHours, when, offset(when))) return false;
    const current = deps.rules.get("system-heartbeat-recheck");
    if (
      current?.state === "active" &&
      current.wake?.status === "scheduled" &&
      dueAt(current.wake) > at
    )
      return false;
    await deps.rules.setSystemSchedule("system-heartbeat-recheck", {
      when: { kind: "schedule", at: when, timezone: timezone(), missedPolicy: "skip" },
      state: "active",
    });
    return true;
  }

  async function heartbeat(rule: SystemScheduleNoticeRule, due: RuleScheduleDue) {
    const settings = deps.settings();
    if (!settings.heartbeat.enabled) return outcome("心跳已关闭。");
    const at = now();
    const zone = offset(at);
    if (
      !inClockWindow(settings.heartbeat.activeHours, at, zone) ||
      isInQuietHours(settings.quietHours, at, zone)
    )
      return outcome("不在活跃时段，未检查。");
    await Promise.all([deps.state.load(), deps.ledger.load()]);
    const day = localDayIndex(at, zone);
    const beat = heartbeatToday(deps.state.get().heartbeat, day);
    // Never further back than two hours (a long gap: switched off, asleep, capped).
    const since = Math.max(
      beat.lastAt ?? at - HEARTBEAT_INTERVAL_MIN * MINUTE,
      at - HEARTBEAT_LOOKBACK_MS,
    );
    const facts = heartbeatPrecheck({
      now: at,
      since,
      seen: new Set(beat.seen),
      recent: deps.ledger.changedSince(since),
      followUps: followUps(),
      sessions: deps.sessions(),
      sessionWatched: (sessionId) => deps.rules.activeForSession(sessionId).length > 0,
      wasSessionViewedSince: deps.wasSessionViewedSince,
    });
    /** Move the cursor past these facts: they are not new any more. */
    const advance = (also: (draft: typeof beat) => void = () => undefined) =>
      deps.state.update((draft) => {
        const next = heartbeatToday(draft.heartbeat, day);
        next.lastAt = at;
        next.seen = [...next.seen, ...facts.map((fact: HeartbeatFact) => fact.key)];
        also(next);
        draft.heartbeat = next;
      });
    if (facts.length === 0) {
      await advance();
      return outcome("没有新情况，未调用模型。");
    }
    // At a cap the facts are left as they are (not judged, not consumed).
    if (beat.judged >= HEARTBEAT_JUDGE_CAP)
      return outcome(`今天的判断次数已用完（${HEARTBEAT_JUDGE_CAP} 次），未调用模型。`);
    // Nothing could be said today anyway: no judgement is spent on it.
    if (beat.said >= HEARTBEAT_SAY_CAP)
      return outcome(`今天的心跳消息已达上限（${HEARTBEAT_SAY_CAP} 条），未调用模型。`);
    // Counted before the call, so a crash mid-call cannot get past the cap.
    await deps.state.update((draft) => {
      const next = heartbeatToday(draft.heartbeat, day);
      next.judged += 1;
      // Pinned, so facts left for a later look (a failed call, a recheck) stay new.
      next.lastAt ??= since;
      draft.heartbeat = next;
    });
    const context = { now: at, saidToday: beat.said, offsetMin: offset };
    const judgement = await judgeHeartbeat(facts, context, deps.models, {
      ...(deps.modelTimeoutMs !== undefined ? { timeoutMs: deps.modelTimeoutMs } : {}),
      onError: onError("pet.proactive.judge_model_failed"),
    });
    // No valid answer is "judge again later", never "nothing to say".
    if (!judgement) return outcome("这次没能判断，下次再看。", "failed");
    if (judgement.say) {
      // Beats run one at a time, so the cap checked above still holds.
      await advance((next) => {
        next.said += 1;
      });
      const decision = await deps.submit({
        kind: "heartbeat",
        priority: "P1",
        dedupeKey: `heartbeat:${due.key}`,
        ruleIds: [rule.id],
        facts: { title: "Mimi", summary: judgement.text },
        body: judgement.text,
        attention: "always",
        channel: "auto",
        target: { kind: "owner" },
        actions: { family: "notice" },
      });
      return outcome(`已提醒（${decision.reason}）。`);
    }
    // The recheck itself never asks for another: one extra look at most.
    if (
      judgement.recheckInMin !== undefined &&
      rule.id !== "system-heartbeat-recheck" &&
      (await armRecheck(judgement.recheckInMin, at))
    )
      return outcome(`暂不打扰，${judgement.recheckInMin} 分钟后再看。`);
    await advance();
    return outcome("暂不打扰。");
  }

  const sync = (): Promise<void> => {
    const run = syncing
      .catch(() => undefined)
      .then(async () => {
        await deps.rules.load();
        await syncSystemSchedules(deps.rules, deps.settings(), timezone(), deps.log);
      });
    syncing = run.catch(onError("pet.proactive.sync_failed"));
    return run;
  };

  /** One heartbeat at a time: a recheck and a regular beat never race the caps. */
  let beating: Promise<unknown> = Promise.resolve();
  const oneBeat = (rule: SystemScheduleNoticeRule, due: RuleScheduleDue) => {
    const run = beating.catch(() => undefined).then(() => heartbeat(rule, due));
    beating = run.catch(() => undefined);
    return run;
  };

  return {
    async fire(rule, due) {
      // The host's timezone moved (travel, a settings change): retime the rules.
      if (rule.when.timezone !== timezone()) void sync().catch(() => undefined);
      return rule.then.mode === "compose" ? brief(rule.then.brief, rule, due) : oneBeat(rule, due);
    },
    sync,
    async start() {
      if (unsubscribe) return;
      unsubscribe = deps.onSettingsChange(() => {
        void sync().catch(() => undefined);
      });
      await deps.state.load().catch(onError("pet.proactive.state_load_failed"));
      await sync().catch(() => undefined);
    },
    status() {
      const state = deps.state.get();
      const at = now();
      const beat = heartbeatToday(state.heartbeat, localDayIndex(at, offset(at)));
      const day = (mark?: { day: number }) =>
        mark
          ? { lastSentDay: new Date(localDayStart(mark.day, 0)).toISOString().slice(0, 10) }
          : {};
      return {
        briefs: { morning: day(state.briefs.morning), evening: day(state.briefs.evening) },
        heartbeat: {
          judgedToday: beat.judged,
          saidToday: beat.said,
          judgeCap: HEARTBEAT_JUDGE_CAP,
          sayCap: HEARTBEAT_SAY_CAP,
          atJudgeCap: beat.judged >= HEARTBEAT_JUDGE_CAP,
          atSayCap: beat.said >= HEARTBEAT_SAY_CAP,
        },
      };
    },
    dispose() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
