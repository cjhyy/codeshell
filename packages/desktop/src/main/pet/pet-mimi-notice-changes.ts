import {
  isPetNotificationSettingsMutation,
  isPetTriggerMutationRequest,
  petTriggerChanges,
  PET_SNOOZE_MAX_MINUTES,
  type PetNotificationSettingsMutation,
  type PetTriggerMutation,
} from "@cjhyy/code-shell-pet/protocol";
import type {
  PetNoticeRuleSummary,
  PetNoticeRuleUpdate,
  PetNoticeRuleUpdateResult,
  PetNotificationSettingsView,
} from "../../shared/pet-notices.js";
import type { PetHostActionContext } from "./pet-dispatch-service.js";
import { noticeLine } from "./pet-notice-compose.js";
import { hostTimezoneOffsetMin } from "./pet-notice-policy.js";
import { localIsoTime } from "./pet-notice-reply-interpreter.js";
import type { NotificationSettingsWrite } from "./pet-notice-rule-list.js";
import { notificationsWriteProblem } from "./pet-notice-settings.js";

/**
 * The host side of Mimi's ManageTrigger and NotificationSettings updates
 * (design §4.7). Both run after her turn as deferred host actions; the only
 * thing taken from the model is the structured change itself (and the rule
 * id being edited). Who may change anything comes from the authenticated
 * turn: the desktop owner, or the owner's own private IM chat with Mimi.
 *
 * Rule changes go through the rule list's updater (`pet:notices:update-rule`)
 * and the settings through the same `pet.notifications` write as the settings
 * page, so neither path has a second copy of the mutation logic.
 */

const MINUTE = 60_000;
const SNOOZE_MAX_MS = PET_SNOOZE_MAX_MINUTES * MINUTE;
const SNOOZE_MIN_MS = MINUTE;
const SYSTEM_RULES = new Set([
  "all-sessions",
  "system-brief-morning",
  "system-brief-evening",
  "system-heartbeat",
]);
const BRIEF_OF: Readonly<Record<string, "morning" | "evening">> = {
  "system-brief-morning": "morning",
  "system-brief-evening": "evening",
};

/** The rule list and its updater, as the settings page uses them (`PetNoticeControls`). */
export interface MimiNoticeRuleControls {
  rules(): Promise<readonly PetNoticeRuleSummary[]>;
  updateRule(request: PetNoticeRuleUpdate): Promise<PetNoticeRuleUpdateResult>;
}

export interface MimiNoticeChangesDeps {
  controls(): MimiNoticeRuleControls | undefined;
  settingsView(): PetNotificationSettingsView;
  /** `pet.notifications` deep-merge write (null deletes); main re-syncs after it. */
  writeNotificationSettings?: NotificationSettingsWrite;
  isOwnerConversation(channel: string, target: string): boolean;
  now?: () => number;
  timezoneOffsetMin?: (ms: number) => number;
}

/**
 * Why this turn may not change the owner's notices; undefined when it may.
 * The desktop is the owner; over IM only an allowlisted owner conversation
 * that the adapter reports as a private chat counts. A turn without
 * authenticated routing facts never does.
 */
export function ownerTurnRefusal(
  context: PetHostActionContext | undefined,
  isOwnerConversation: (channel: string, target: string) => boolean,
): string | undefined {
  const unverified = "这次请求的来源无法核实，没有修改。";
  if (!context) return unverified;
  const route = context.completionTarget;
  if (!route) return context.originRef?.kind === "desktop" ? undefined : unverified;
  if (context.isDirectMessage !== true)
    return "群聊里不能修改提醒和通知设置，没有修改。请在桌面或和 Mimi 的私聊里说。";
  if (!isOwnerConversation(route.channel, route.target))
    return "只有主人本人能修改提醒和通知设置，没有修改。";
  return undefined;
}

function triggerName(rule: PetNoticeRuleSummary): string {
  if (rule.id === "all-sessions") return "「不在电脑前时所有会话都推我」";
  if (rule.id === "system-brief-morning") return "晨报";
  if (rule.id === "system-brief-evening") return "收工小结";
  if (rule.id === "system-heartbeat") return "心跳";
  const title = noticeLine(rule.title ?? rule.sessionTitle, 60);
  if (rule.kind === "schedule") return title ? `跟进「${title}」` : "这条跟进";
  return title ? `会话「${title}」的提醒` : "这条会话提醒";
}

const VERBS: Readonly<Record<string, string>> = {
  pause: "已暂停",
  resume: "已恢复",
  cancel: "已删除",
  enable: "已打开",
  disable: "已关闭",
};

const REFUSALS: Readonly<Record<string, string>> = {
  version_conflict: "这条提醒刚被改过，没有修改；请重新查看后再说。",
  not_found: "找不到这条提醒（可能已经结束或被删除），没有修改。",
  not_allowed: "这条提醒现在不能这样改，没有修改。",
};

export function createMimiNoticeChanges(deps: MimiNoticeChangesDeps) {
  const now = deps.now ?? Date.now;
  const offset = deps.timezoneOffsetMin ?? hostTimezoneOffsetMin;

  /** "HH:MM" today, "MM-DD HH:MM" otherwise, owner-local. */
  const clockOf = (ms: number): string => {
    const at = localIsoTime(ms, offset(ms));
    const today = localIsoTime(now(), offset(now())).slice(0, 10);
    return at.slice(0, 10) === today ? at.slice(11, 16) : `${at.slice(5, 10)} ${at.slice(11, 16)}`;
  };

  const writeSettings = async (notifications: Record<string, unknown>): Promise<void> => {
    if (!deps.writeNotificationSettings) throw new Error("通知设置当前不可修改。");
    const problem = notificationsWriteProblem(notifications);
    if (problem) throw new Error(`设置项 ${problem} 的值无效，没有修改。`);
    await deps.writeNotificationSettings(notifications);
  };

  /**
   * One ManageTrigger call: a single change (its refusal fails the action),
   * or up to five applied in order against fresh versions, each reported on
   * its own line; only when none of them applied does the action fail.
   */
  async function changeTrigger(
    payload: Record<string, unknown>,
    context?: PetHostActionContext,
  ): Promise<Record<string, unknown>> {
    const refusal = ownerTurnRefusal(context, deps.isOwnerConversation);
    if (refusal) throw new Error(refusal);
    if (!isPetTriggerMutationRequest(payload)) throw new Error("invalid trigger change");
    const controls = deps.controls();
    if (!controls) throw new Error("提醒规则还没有准备好，没有修改。");
    if (!("changes" in payload)) return changeOne(controls, payload);
    const lines: string[] = [];
    const results: Array<Record<string, unknown>> = [];
    for (const change of petTriggerChanges(payload)) {
      try {
        const result = await changeOne(controls, change);
        results.push({ ok: true, ...result });
        lines.push(String(result.message));
      } catch (error) {
        const rule = (await controls.rules().catch(() => [])).find(
          (row) => row.id === change.ruleId,
        );
        const reason = error instanceof Error ? error.message : String(error);
        results.push({ ok: false, ruleId: change.ruleId, error: reason });
        lines.push(`${rule ? triggerName(rule) : change.ruleId}：${reason}`);
      }
    }
    if (results.every((result) => result.ok === false)) throw new Error(lines.join("\n"));
    return { message: lines.join("\n"), results };
  }

  async function changeOne(
    controls: MimiNoticeRuleControls,
    change: PetTriggerMutation,
  ): Promise<Record<string, unknown>> {
    const rule = (await controls.rules()).find((row) => row.id === change.ruleId);
    if (!rule) throw new Error(REFUSALS.not_found);
    if (change.expectedVersion !== undefined && change.expectedVersion !== rule.version)
      throw new Error(REFUSALS.version_conflict);
    const name = triggerName(rule);
    const system = SYSTEM_RULES.has(rule.id);

    if (change.action === "set_time") {
      const brief = BRIEF_OF[rule.id];
      if (!brief) throw new Error("只有晨报和收工小结能改时间，没有修改。");
      await writeSettings({ briefs: { [brief]: { time: change.time } } });
      const off = rule.state !== "active" ? `（${name}目前是关着的，打开后按这个时间发）` : "";
      return { message: `${name}时间改为每天 ${change.time}。${off}`, ruleId: rule.id };
    }
    if (change.action === "set_active_hours") {
      if (rule.id !== "system-heartbeat") throw new Error("只有心跳能改活跃时段，没有修改。");
      await writeSettings({ heartbeat: { activeHours: { start: change.start, end: change.end } } });
      const off = rule.state !== "active" ? "（心跳目前是关着的）" : "";
      return {
        message: `心跳的活跃时段改为 ${change.start}–${change.end}。${off}`,
        ruleId: rule.id,
      };
    }
    if ((change.action === "enable" || change.action === "disable") && !system)
      throw new Error("只有 Mimi 的系统提醒能打开或关闭；这条请用暂停、恢复或删除。");
    const action =
      change.action === "enable" ? "resume" : change.action === "disable" ? "pause" : change.action;
    if (system && action === "cancel")
      throw new Error(`${name}是 Mimi 的系统提醒，不能删除，只能关闭。`);
    // Already in the asked state: nothing to write, and saying so is the truth.
    if (system && (action === "resume") === (rule.state === "active"))
      return {
        message: `${name}本来就是${rule.state === "active" ? "开着" : "关着"}的，没有变化。`,
        ruleId: rule.id,
      };
    const result = await controls.updateRule({
      ruleId: rule.id,
      expectedVersion: rule.version,
      action,
    });
    if (!result.ok) throw new Error(REFUSALS[result.reason] ?? REFUSALS.not_allowed);
    const after = result.rule;
    const next =
      after?.schedule?.nextAt !== undefined ? `下一次：${clockOf(after.schedule.nextAt)}。` : "";
    return {
      message: `${name}${VERBS[change.action]}。${next}`,
      ruleId: rule.id,
      ...(after ? { state: after.state, version: after.version } : {}),
    };
  }

  /** The settings write for a patch: only what was asked, completed where the schema needs it. */
  function settingsWrite(
    mutation: PetNotificationSettingsMutation,
    view: PetNotificationSettingsView,
  ): { write: Record<string, unknown>; lines: string[] } {
    const write: Record<string, unknown> = {};
    const lines: string[] = [];
    const patch = mutation.patch ?? {};
    if (patch.quietHours) {
      // The schema stores the window whole; untouched parts keep their current value.
      const quiet = {
        enabled: patch.quietHours.enabled ?? view.quietHours.enabled,
        start: patch.quietHours.start ?? view.quietHours.start,
        end: patch.quietHours.end ?? view.quietHours.end,
      };
      write.quietHours = quiet;
      lines.push(quiet.enabled ? `免打扰 ${quiet.start}–${quiet.end}` : "免打扰已关闭");
    }
    if (patch.maxPerHour !== undefined) {
      write.maxPerHour = patch.maxPerHour;
      lines.push(`每小时最多推 ${patch.maxPerHour} 条`);
    }
    if (patch.maxP0PerHour !== undefined) {
      write.maxP0PerHour = patch.maxP0PerHour;
      lines.push(`需要你决定的事每小时最多推 ${patch.maxP0PerHour} 条`);
    }
    if (patch.mergeWindowSec !== undefined) {
      write.mergeWindowSec = patch.mergeWindowSec;
      lines.push(`同一会话 ${patch.mergeWindowSec} 秒内的结果合并`);
    }
    if (patch.presenceIdleSec !== undefined) {
      write.presenceIdleSec = patch.presenceIdleSec;
      lines.push(`电脑空闲 ${patch.presenceIdleSec} 秒算离开`);
    }
    if (patch.delegatedFromDesktop !== undefined) {
      write.delegatedFromDesktop = patch.delegatedFromDesktop;
      lines.push(
        patch.delegatedFromDesktop === "desktop"
          ? "桌面派的活只在桌面告诉你"
          : "桌面派的活：在电脑前发桌面，不在时发 IM",
      );
    }
    if (patch.digestSlots !== undefined) {
      const slots = [...patch.digestSlots].sort();
      write.digestSlots = slots;
      lines.push(slots.length ? `摘要固定在 ${slots.join("、")} 发` : "摘要不再固定时间");
    }
    if (patch.briefs) {
      write.briefs = patch.briefs;
      for (const brief of ["morning", "evening"] as const) {
        const slot = patch.briefs[brief];
        if (!slot) continue;
        const name = brief === "morning" ? "晨报" : "收工小结";
        const parts = [
          ...(slot.enabled !== undefined ? [slot.enabled ? "已打开" : "已关闭"] : []),
          ...(slot.time ? [`每天 ${slot.time}`] : []),
        ];
        lines.push(`${name}${parts.join("，")}`);
      }
    }
    if (patch.heartbeat) {
      write.heartbeat = patch.heartbeat;
      const parts = [
        ...(patch.heartbeat.enabled !== undefined
          ? [patch.heartbeat.enabled ? "已打开" : "已关闭"]
          : []),
        ...(patch.heartbeat.activeHours
          ? [`活跃时段 ${patch.heartbeat.activeHours.start}–${patch.heartbeat.activeHours.end}`]
          : []),
      ];
      lines.push(`心跳${parts.join("，")}`);
    }
    if (mutation.snooze !== undefined) {
      const at = now();
      if (mutation.snooze === null) {
        write.snoozeUntil = null;
        const current = view.snoozeUntil;
        lines.push(current !== undefined && current > at ? "已取消静音" : "现在没有静音，无需取消");
      } else {
        const until =
          "minutes" in mutation.snooze
            ? at + mutation.snooze.minutes * MINUTE
            : mutation.snooze.until;
        if (until - at < SNOOZE_MIN_MS || until - at > SNOOZE_MAX_MS)
          throw new Error("静音只能设到将来 1 分钟到 24 小时之内，没有修改。");
        write.snoozeUntil = Math.ceil(until / MINUTE) * MINUTE;
        lines.push(
          `静音到 ${clockOf(write.snoozeUntil as number)}：这期间只推需要你决定的事，其余到时合成一条摘要`,
        );
      }
    }
    return { write, lines };
  }

  async function changeSettings(
    payload: Record<string, unknown>,
    context?: PetHostActionContext,
  ): Promise<Record<string, unknown>> {
    const refusal = ownerTurnRefusal(context, deps.isOwnerConversation);
    if (refusal) throw new Error(refusal);
    if (!isPetNotificationSettingsMutation(payload)) throw new Error("invalid settings change");
    const { write, lines } = settingsWrite(payload, deps.settingsView());
    await writeSettings(write);
    return { message: `通知设置已更新：${lines.join("；")}。`, fields: Object.keys(write) };
  }

  return {
    noticeTriggerMutation: changeTrigger,
    notificationSettingsMutation: changeSettings,
  };
}
