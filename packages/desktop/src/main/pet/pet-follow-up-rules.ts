import { createHash } from "node:crypto";
import type { CronScheduler } from "@cjhyy/code-shell-core/internal";
import {
  isPetFollowUpMutationPayload,
  type PetFollowUpMutationPayload,
  type PetFollowUpWake,
  type PetRegisteredFollowUpStatus,
} from "@cjhyy/code-shell-pet";
import type { PetDispatchService, PetHostActionContext } from "./pet-dispatch-service.js";
import { createPetFollowUpService, type PetFollowUpInbox } from "./pet-follow-up-service.js";
import type { PetLongTaskCoordinator } from "./pet-long-task-coordinator.js";
import type { PetLongTaskStore } from "./pet-long-task-store.js";
import type { PetNoticePowerEvents } from "./pet-notice-decision-hooks.js";
import { createFollowUpNotifier } from "./pet-notice-follow-up.js";
import type { RouteDecision } from "./pet-notice-policy.js";
import type { NoticeSubmission } from "./pet-notice-types.js";
import { PetRuleScheduler } from "./pet-rule-schedule.js";
import {
  isScheduleRule,
  PetRuleStoreError,
  type NoticeRule,
  type PetRuleStore,
  type ScheduleNoticeRule,
} from "./pet-rule-store.js";
import {
  cronProblem,
  DEFAULT_CATCH_UP_MS,
  occurrenceDeadline,
  upcomingOccurrences,
  type ScheduleThen,
  type ScheduleWhen,
} from "./pet-schedule-rule.js";
import type { DesktopPetSession } from "./pet-state-aggregator.js";
import type { PetSummaryService } from "./pet-summary-service.js";
import type { PetSummaryStore } from "./pet-summary-store.js";

/**
 * Follow-ups are schedule rules (design §10.1): `ManageFollowUp` writes rules,
 * `FollowUps` and the workbench read them, and the rule scheduler fires them.
 * There is no follow-up store of its own any more; the old `follow-ups.json`
 * is deleted at startup without migration (owner decision, 2026-11-11).
 *
 * Authority stays with the host: the operation key (and so the rule id) comes
 * from the authenticated turn, the destination from the turn's IM origin,
 * never from the model's arguments; `resume` only targets a native Session.
 */

/** Slot identity is host-authored; model-provided titles never identify an operation. */
export function petFollowUpOperationKey(context: PetHostActionContext): string {
  return `followup-registration:${createHash("sha256")
    .update(
      JSON.stringify([
        context.originClientMessageId,
        context.actionIndex ?? 0,
        context.completionTarget?.channel ?? "desktop",
        context.completionTarget?.target ?? null,
        context.senderId ?? context.completionTarget?.senderId ?? null,
      ]),
    )
    .digest("hex")}`;
}

/** Deterministic rule id for an operation, so a replayed registration finds its rule. */
export function followUpRuleId(operationKey: string): string {
  const hex = createHash("sha256").update(operationKey).digest("hex");
  return `rule-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function isFollowUpRule(rule: NoticeRule): rule is ScheduleNoticeRule {
  return isScheduleRule(rule) && rule.createdBy === "follow-up";
}

/** A follow-up rule as the FollowUps tool and the workbench see it. */
export interface PetFollowUpRuleView {
  id: string;
  revision: number;
  title: string;
  text: string;
  /** The current occurrence (next to fire, or the one that last fired). */
  wakeAt: number;
  recurrence?: string;
  /** Mimi's plain-language name of the recurrence (untrusted display text). */
  scheduleLabel?: string;
  timezone: string;
  intent: "remind" | "resume";
  missedPolicy: "skip" | "fire-once";
  catchUpUntil: number;
  status: PetRegisteredFollowUpStatus;
  wakeState: ScheduleNoticeRule["wake"]["status"];
  wakeDetail?: string;
  createdAt: number;
  sourceSessionId?: string;
  taskId?: string;
}

function statusOf(rule: NoticeRule): PetRegisteredFollowUpStatus {
  if (rule.state === "active" || rule.state === "paused") return "open";
  return rule.state === "completed" ? "completed" : "cancelled";
}

export function followUpRuleView(rule: ScheduleNoticeRule): PetFollowUpRuleView {
  const then = rule.then;
  const taskId = rule.wake.taskId ?? (then.mode === "run-mimi" ? then.taskId : undefined);
  return {
    id: rule.id,
    revision: rule.version,
    title: then.title,
    text: then.text,
    wakeAt: rule.wake.occurrence,
    ...(rule.when.cron !== undefined
      ? { recurrence: rule.when.cron, scheduleLabel: rule.when.label ?? rule.when.cron }
      : {}),
    timezone: rule.when.timezone,
    intent: then.mode === "run-mimi" ? "resume" : "remind",
    missedPolicy: rule.when.missedPolicy,
    catchUpUntil: occurrenceDeadline(rule.when, rule.wake.occurrence),
    status: statusOf(rule),
    wakeState: rule.wake.status,
    ...(rule.wake.detail ? { wakeDetail: rule.wake.detail } : {}),
    createdAt: rule.createdAt,
    ...(then.mode === "run-mimi" ? { sourceSessionId: then.sourceSessionId } : {}),
    ...(taskId ? { taskId } : {}),
  };
}

/** The occurrence handed to Mimi's wake turn and the reminder. */
export function followUpWake(rule: ScheduleNoticeRule, occurrence: number): PetFollowUpWake {
  const then = rule.then;
  return {
    id: rule.id,
    revision: rule.version,
    occurrence,
    title: then.title,
    text: then.text,
    intent: then.mode === "run-mimi" ? "resume" : "remind",
    ...(then.mode === "run-mimi" ? { sourceSessionId: then.sourceSessionId } : {}),
    ...(then.mode === "run-mimi" && then.taskId ? { taskId: then.taskId } : {}),
    ...(rule.target.kind === "route" ? { completionTarget: rule.target.route } : {}),
  };
}

const STORE_ERRORS: Partial<Record<string, string>> = {
  version_conflict: "跟进项版本已更新，请重新读取",
  rule_not_found: "跟进项不存在或已处理",
  invalid_rule: "跟进项不存在、已处理或请求无效",
  schedule_in_past: "跟进时间必须在未来",
  schedule_never_fires: "重复规则在两年内都不会触发，请检查 recurrence",
  rule_store_full: "规则表已满，请先处理一些已完成的跟进",
  rule_store_unwritable: "规则表由更新版本写入，当前版本不能修改",
};

/** Store failures as sentences Mimi can relay; anything else passes through. */
async function explained<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof PetRuleStoreError)
      throw new Error(STORE_ERRORS[error.code] ?? error.code, { cause: error });
    throw error;
  }
}

type Timing = Extract<PetFollowUpMutationPayload, { action: "register" | "reschedule" }>;

function scheduleWhen(payload: Timing): ScheduleWhen {
  const missedPolicy = payload.missedPolicy ?? "fire-once";
  if (payload.recurrence !== undefined) {
    const problem = cronProblem(payload.recurrence);
    if (problem) throw new Error(problem);
    return {
      kind: "schedule",
      cron: payload.recurrence,
      label: payload.scheduleLabel!,
      timezone: payload.timezone,
      missedPolicy,
    };
  }
  const at = payload.wakeAt!;
  return {
    kind: "schedule",
    at,
    timezone: payload.timezone,
    missedPolicy,
    catchUpUntil: payload.catchUpUntil ?? at + DEFAULT_CATCH_UP_MS,
  };
}

function receipt(action: string, rule: ScheduleNoticeRule): Record<string, unknown> {
  const view = followUpRuleView(rule);
  return {
    action,
    followUpId: view.id,
    title: view.title,
    revision: view.revision,
    wakeAt: view.wakeAt,
    ...(view.recurrence
      ? {
          recurrence: view.recurrence,
          scheduleLabel: view.scheduleLabel,
          // What the owner is told: this one and the one after.
          upcoming: upcomingOccurrences(rule.when, view.wakeAt),
        }
      : {}),
    timezone: view.timezone,
    intent: view.intent,
    status: view.status,
    wakeState: view.wakeState,
  };
}

export interface PetFollowUpRulesDeps {
  rules: PetRuleStore;
  sessions(): readonly DesktopPetSession[];
  summaryStore: PetSummaryStore;
  summaryService: PetSummaryService;
  inbox: PetFollowUpInbox;
  tasks: PetLongTaskStore;
  longTasks: Pick<PetLongTaskCoordinator, "control">;
  scheduler(): CronScheduler;
  /** The notice router (`PetNoticeWiring.submitNotice`): every reminder is sent through it. */
  submitNotice(notice: NoticeSubmission): Promise<RouteDecision>;
  dispatch(): Pick<PetDispatchService, "wakeFollowUp"> | null;
  powerEvents?: Pick<PetNoticePowerEvents, "on" | "removeListener">;
  legacyFollowUpsPath?: string;
  now?: () => number;
  onError(error: unknown): void;
  log?(event: string, data: Record<string, unknown>): void;
}

/** Compose follow-ups on the rule table; Desktop supplies lifecycle, routing and authority. */
export async function createPetFollowUpRules(deps: PetFollowUpRulesDeps) {
  const { rules } = deps;
  const now = deps.now ?? Date.now;
  const followUpRules = () => rules.list().filter(isFollowUpRule);
  const petFollowUps = createPetFollowUpService({
    listSessions: deps.sessions,
    summaryStore: deps.summaryStore,
    summaryService: deps.summaryService,
    inbox: deps.inbox,
    registered: { load: () => rules.load(), list: () => followUpRules().map(followUpRuleView) },
  });

  const followUpRule = (id: string): ScheduleNoticeRule => {
    const rule = rules.get(id);
    if (!rule || !isFollowUpRule(rule)) throw new Error("跟进项不存在或已处理");
    return rule;
  };

  async function register(
    payload: Extract<PetFollowUpMutationPayload, { action: "register" }>,
    context: PetHostActionContext | undefined,
  ): Promise<Record<string, unknown>> {
    if (!context) throw new Error("follow-up registration requires an authenticated current turn");
    await rules.load();
    const id = followUpRuleId(petFollowUpOperationKey(context));
    // A replay resolves the original operation, even edited or after its task disappeared.
    const existing = rules.get(id);
    if (existing && isFollowUpRule(existing)) return receipt("register", existing);
    let taskId = payload.taskId;
    if (payload.intent === "resume") {
      const source = deps.sessions().find((row) => row.agentSessionId === payload.sourceSessionId);
      if (!source || source.external)
        throw new Error("续办来源已不存在或不受当前 Host 支持，请重新选择原任务");
      const task = taskId
        ? deps.tasks.get(taskId)
        : deps.tasks
            .getSnapshot()
            .tasks.find(
              (row) =>
                row.sessionId === payload.sourceSessionId &&
                !["completed", "failed", "cancelled"].includes(row.status),
            );
      if (taskId && (!task || task.sessionId !== payload.sourceSessionId))
        throw new Error("续办任务与来源 Session 不匹配");
      taskId = task?.id;
    }
    const then: ScheduleThen =
      payload.intent === "resume"
        ? {
            mode: "run-mimi",
            title: payload.title,
            text: payload.text,
            sourceSessionId: payload.sourceSessionId!,
            ...(taskId ? { taskId } : {}),
          }
        : { mode: "remind", title: payload.title, text: payload.text };
    const route = context.completionTarget;
    const rule = await explained(
      rules.createScheduleRule({
        id,
        when: scheduleWhen(payload),
        then,
        channel: route ? route.channel : "auto",
        target: route ? { kind: "route", route } : { kind: "owner" },
      }),
    );
    return receipt("register", rule);
  }

  /** `followUpMutation` host action, and the workbench's controls (no context). */
  async function followUpHost(
    input: Record<string, unknown>,
    context?: PetHostActionContext,
  ): Promise<Record<string, unknown>> {
    const payload: unknown = input;
    if (!isPetFollowUpMutationPayload(payload)) throw new Error("invalid follow-up request");
    if (payload.action === "register") return register(payload, context);
    if (!payload.followUpId.startsWith("rule-")) {
      // Result-derived rows keep their handled-state namespace.
      if (payload.action !== "complete" && payload.action !== "dismiss")
        throw new Error("invalid follow-up mutation request");
      return { ...(await petFollowUps.mutate(payload)) };
    }
    await rules.load();
    const current = followUpRule(payload.followUpId);
    if (payload.expectedRevision === undefined)
      throw new Error("registered follow-up requires expectedRevision");
    if (payload.action === "reschedule") {
      const rule = await explained(
        rules.rescheduleRule(current.id, payload.expectedRevision, scheduleWhen(payload)),
      );
      return receipt("reschedule", followUpRule(rule.id));
    }
    if (statusOf(current) !== "open") throw new Error("跟进项不存在或已处理");
    const rule = await explained(
      rules.update(current.id, payload.expectedRevision, {
        state: payload.action === "complete" ? "completed" : "cancelled",
      }),
    );
    return receipt(payload.action, followUpRule(rule.id));
  }

  const notify = createFollowUpNotifier({ submit: deps.submitNotice, now });
  /** `run-mimi`: continue the exact original Session, never bypassing a decision. */
  const resume = async (
    wake: PetFollowUpWake,
  ): Promise<{ launched: boolean; text: string; taskId?: string }> => {
    const source = deps.sessions().find((row) => row.agentSessionId === wake.sourceSessionId);
    if (!source || source.external)
      return {
        launched: false,
        text: "原任务已不存在或不受当前 Host 支持，未启动新的任务。请重新选择。",
      };
    if (source.pendingDecisionCount > 0)
      return { launched: false, text: "原任务正在等待你的决定，已保留跟进，未绕过审批。" };
    if (source.runState === "running" || source.runState === "queued")
      return { launched: false, text: "原任务已在运行，未重复启动。" };
    if (wake.taskId) {
      const task = deps.tasks.get(wake.taskId);
      if (!task || task.sessionId !== wake.sourceSessionId)
        return { launched: false, text: "跟进关联的原任务已变化，请核对后再续办。" };
      if (task.status === "paused" || task.status === "interrupted") {
        const result = await deps.longTasks.control({ action: "resume", taskId: task.id });
        if (!result.ok) return { launched: false, text: `未能续办原任务：${result.message}` };
        return { launched: true, text: "已续办原任务，完成后会报告实际结果。", taskId: task.id };
      }
      if (task.status === "waiting")
        return {
          launched: false,
          text: task.waitingFor ?? "原任务仍在等待外部结果或你的决定，未重复启动。",
        };
      if (task.status === "cancelled")
        return { launched: false, text: "原任务已取消，未自动重启。" };
    }
    const dispatch = deps.dispatch();
    if (!dispatch) throw new Error("Mimi dispatch service is unavailable");
    return dispatch.wakeFollowUp(wake);
  };

  const coordinator = new PetRuleScheduler({
    rules,
    scheduler: deps.scheduler,
    fire: async (rule, due) => {
      const wake = followUpWake(rule, due.occurrence);
      const outcome =
        rule.then.mode === "run-mimi"
          ? await resume(wake)
          : { launched: false, text: rule.then.text };
      // The router picks desktop / IM, records and dedupes the reminder (key: the occurrence).
      await notify({ ...wake, catchUpUntil: due.deadline }, outcome.text, due.key);
      return {
        status: outcome.launched ? "launched" : "notified",
        detail: outcome.text,
        ...(outcome.taskId ? { taskId: outcome.taskId } : {}),
      };
    },
    ...(deps.powerEvents ? { powerEvents: deps.powerEvents } : {}),
    ...(deps.legacyFollowUpsPath ? { legacyFollowUpsPath: deps.legacyFollowUpsPath } : {}),
    now,
    onError: deps.onError,
    ...(deps.log ? { log: deps.log } : {}),
  });
  // Not fatal: a rule table this build cannot write (or read) leaves
  // follow-ups off, logged, while the rest of Mimi and the bridge start.
  await coordinator.prepare().catch((error) => {
    deps.log?.("pet.followUp.prepare_failed", { error: String(error) });
    deps.onError(error);
  });

  return {
    petFollowUps,
    followUpHost,
    coordinator,
    subscribe: (listener: () => void) => rules.onChange(listener),
    /** Re-checked after Mimi decides, right before her wake turn launches anything. */
    validateContinuation(wake: PetFollowUpWake): void {
      const current = rules.get(wake.id);
      if (
        !current ||
        !isFollowUpRule(current) ||
        current.version !== wake.revision ||
        current.state !== "active" ||
        current.wake.status !== "claimed" ||
        current.wake.occurrence !== wake.occurrence
      )
        throw new Error("跟进授权已变化，未自动续办");
      if (wake.taskId) {
        const task = deps.tasks.get(wake.taskId);
        if (
          !task ||
          task.sessionId !== wake.sourceSessionId ||
          ["cancelled", "waiting", "running", "queued"].includes(task.status)
        )
          throw new Error("原任务已取消、正在运行或等待决定，未自动续办");
      }
    },
  };
}
