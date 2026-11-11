import type { PetLongTask, PetLongTaskCompletionTarget } from "@cjhyy/code-shell-pet";
import { NOTICE_EVENTS } from "@cjhyy/code-shell-pet/protocol";
import type { PetHostActionExecutor } from "./pet-dispatch-service.js";
import { errorText } from "./pet-notice-types.js";
import type { DesktopPetSession } from "./pet-state-aggregator.js";
import { noticeTargetKey, type NoticeRule, type PetRuleStore } from "./pet-rule-store.js";

/**
 * Mimi's WatchSession host action: "tell this IM conversation when that
 * Session is done". It is a notice rule (`createdBy: "watch-session"`,
 * addressed to the conversation), so the rule watcher reports the Session's
 * done / failed / blocked like any other rule and decision prompts follow it.
 * No long task is created for a watch any more. A Session that already
 * belongs to a delegated long task keeps that task as its reporter; the watch
 * only points the task at this conversation (unchanged behaviour), and watch
 * tasks persisted by older builds keep working through the task path.
 */

/** What main supplies; the wiring adds the rule store and decision nudges. */
export interface SessionWatchHostDeps {
  /** Reconcile the Session catalog from disk now (best effort). */
  refreshCatalog(): Promise<unknown>;
  sessions(): readonly DesktopPetSession[];
  longTasks: {
    activeForSession(sessionId: string): PetLongTask | undefined;
    /** Point an active long task at the conversation (`PetLongTaskCoordinator.watchSession`). */
    watchSession(input: {
      originClientMessageId: string;
      requestedAt: number;
      sessionId: string;
      objective: string;
      workspacePath: null;
      completionTarget: PetLongTaskCompletionTarget;
    }): Promise<{ task: PetLongTask; alreadyWatching: boolean }>;
    reconcileNow(): Promise<void>;
  };
  /** The Session's persisted Goal: an active, unpaused Goal makes the rule wait for it. */
  goals: { readActiveGoal(sessionId: string): { paused?: boolean } | undefined };
}

export interface SessionWatchDeps extends SessionWatchHostDeps {
  rules: Pick<PetRuleStore, "load" | "activeForSession" | "upsertSessionRule" | "update">;
  isEligibleSession(sessionId: string): boolean;
  /** A decision already pending in the Session may now have somewhere to go. */
  nudge(sessionId: string): void;
  now(): number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

function ended(title: string, terminal: NonNullable<DesktopPetSession["terminal"]>) {
  return { watching: false, title, status: terminal.status, endedAt: terminal.at };
}

/** Running, queued, waiting for a decision or for background work: an outcome is coming. */
function isUnderWay(session: DesktopPetSession): boolean {
  return (
    session.runState === "running" ||
    session.runState === "queued" ||
    session.pendingDecisionCount > 0 ||
    session.completionKind === "background_wait"
  );
}

export function createSessionWatchAction(deps: SessionWatchDeps): PetHostActionExecutor {
  const goalActive = (sessionId: string): boolean => {
    try {
      const goal = deps.goals.readActiveGoal(sessionId);
      return goal !== undefined && goal.paused !== true;
    } catch {
      return false;
    }
  };
  const refresh = () => deps.refreshCatalog().catch(() => undefined);
  const find = (sessionId: string) =>
    deps.sessions().find((candidate) => candidate.agentSessionId === sessionId);

  /** Withdraw a rule armed too late; false when it already moved on (it fired). */
  const withdraw = async (rule: NoticeRule): Promise<boolean> => {
    try {
      await deps.rules.update(rule.id, rule.version, { state: "cancelled" });
      return true;
    } catch (error) {
      deps.log?.("pet.notice.watch_withdraw_failed", { ruleId: rule.id, error: errorText(error) });
      return false;
    }
  };

  return async (payload, context) => {
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
    const route = context?.completionTarget;
    if (
      !sessionId ||
      !route ||
      !context?.originClientMessageId ||
      !Number.isFinite(context.requestedAt)
    ) {
      throw new Error("当前消息没有可用的完成回告路由");
    }
    // Reconcile first, so a Session that ended while Mimi was composing her
    // reply is reported as ended instead of watched for an end that came.
    await refresh();
    const session = find(sessionId);
    if (!session) throw new Error("指定的工作 Session 已不存在或不可见");
    const title = session.title?.trim() || "未命名任务";
    if (session.terminal) return ended(title, session.terminal);

    if (deps.longTasks.activeForSession(sessionId)) {
      const watched = await deps.longTasks.watchSession({
        originClientMessageId: context.originClientMessageId,
        requestedAt: context.requestedAt,
        sessionId,
        objective: title,
        workspacePath: null,
        completionTarget: route,
      });
      await refresh();
      await deps.longTasks.reconcileNow();
      return {
        watching: true,
        alreadyWatching: watched.alreadyWatching,
        taskId: watched.task.id,
        title,
        status: watched.task.status,
      };
    }

    if (!deps.isEligibleSession(sessionId)) throw new Error("该工作 Session 不支持完成通知");
    if (!isUnderWay(session)) throw new Error("The selected Work Session is not active");
    await deps.rules.load();
    const target: NoticeRule["target"] = { kind: "route", route };
    const key = noticeTargetKey(target);
    const existing = deps.rules
      .activeForSession(sessionId)
      .find((rule) => rule.when.kind === "session" && noticeTargetKey(rule.target) === key);
    if (existing)
      return {
        watching: true,
        alreadyWatching: true,
        ruleId: existing.id,
        title,
        status: "running",
      };

    const rule = await deps.rules.upsertSessionRule({
      sessionId,
      createdBy: "watch-session",
      events: [...NOTICE_EVENTS],
      scope: goalActive(sessionId) ? "goal" : "turn",
      channel: route.channel,
      attention: "always",
      target,
      origin: "user",
      armedAt: deps.now(),
    });
    deps.nudge(sessionId);
    // Close the setup race: an end that landed before the rule existed never fires it.
    await refresh();
    const after = find(sessionId);
    if (after?.terminal && (await withdraw(rule))) return ended(title, after.terminal);
    return { watching: true, alreadyWatching: false, ruleId: rule.id, title, status: "running" };
  };
}
