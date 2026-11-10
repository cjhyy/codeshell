import type { PetLongTask } from "@cjhyy/code-shell-pet";
import type { PetDeliveryResolver } from "./pet-delivery-plan.js";
import {
  errorText,
  parseNoticeMedia,
  type NoticeMedia,
  type NoticeSubmission,
} from "./pet-notice-types.js";
import type { PetRuleStore, NoticeRule } from "./pet-rule-store.js";

const MAX_TITLE = 200;
const MAX_SUMMARY = 2_000;
const MAX_ERROR = 500;

export interface PetTaskClosureNotice {
  /** Mimi's owner-facing closure message, when the closure turn produced one. */
  text?: string;
  /** Files / URL action from the closure turn's validated GatewayReply draft. */
  media?: NoticeMedia;
}

/** One line of untrusted text: whitespace collapsed, trimmed, capped; undefined when empty. */
export function textLine(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/gu, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

export interface PetTaskClosureDeps {
  ruleStore: PetRuleStore;
  deliveries: Pick<PetDeliveryResolver, "plan" | "taskOrigin">;
  /** Stores loaded (the wiring's `ready`). */
  ready: Promise<void>;
  /** Hand a notice to the router (tracked for shutdown, never rejects). */
  submit(notice: NoticeSubmission): Promise<unknown>;
  /** Tell the decision prompts a Session's delivery changed. */
  nudge(sessionId: string): void;
  sessionTitle(sessionId: string): string | undefined;
  now: () => number;
  log: (event: string, data: Record<string, unknown>) => void;
}

export interface PetTaskClosureAdapter {
  /** A long task reached a terminal state and was not continued: one notice, then spend rules. */
  notifyTaskClosed(task: PetLongTask, closure?: PetTaskClosureNotice): Promise<void>;
  /**
   * Mimi started (or re-drove) a delegated Session: arm its automatic notice
   * rule so blocked prompts and the bell follow it. Never throws.
   */
  armDelegationRule(task: PetLongTask): Promise<void>;
}

/** Long tasks as the notice system sees them: an armed rule while running, one notice at the end. */
export function createTaskClosureAdapter(deps: PetTaskClosureDeps): PetTaskClosureAdapter {
  const { ruleStore, deliveries, ready, now, log } = deps;

  async function spend(rules: readonly NoticeRule[]): Promise<void> {
    for (const rule of rules) {
      if (rule.when.kind !== "session") continue;
      try {
        await ruleStore.update(rule.id, rule.version, { state: "spent" });
      } catch (error) {
        log("pet.notice.rule_update_failed", { ruleId: rule.id, error: errorText(error) });
      }
    }
  }

  async function armDelegationRule(task: PetLongTask): Promise<void> {
    try {
      await ready;
      // A rule the owner set on this Session (even paused) is their choice; never rewrite it.
      const ownerRule = ruleStore
        .list()
        .some(
          (rule) =>
            rule.origin === "user" &&
            rule.when.kind === "session" &&
            rule.when.sessionId === task.sessionId &&
            (rule.state === "active" || rule.state === "paused"),
        );
      if (ownerRule) {
        log("pet.notice.delegation_rule_skipped", { sessionId: task.sessionId, reason: "user" });
        return;
      }
      // The rule is the task's delivery declaration: blocked prompts and the
      // bell follow it, and the closure's own entry merges with it.
      await ruleStore.upsertSessionRule({
        sessionId: task.sessionId,
        createdBy: "delegation",
        events: ["done", "failed", "blocked"],
        scope: task.verificationMode === "goal" ? "goal" : "turn",
        ...deliveries.taskOrigin(task),
        attention: "always",
        origin: "delegation",
        armedAt: now(),
      });
      deps.nudge(task.sessionId);
    } catch (error) {
      log("pet.notice.delegation_rule_failed", {
        sessionId: task.sessionId,
        error: errorText(error),
      });
    }
  }

  async function notifyTaskClosed(
    task: PetLongTask,
    closure: PetTaskClosureNotice = {},
  ): Promise<void> {
    if (task.status === "cancelled") {
      // No notice for a cancelled delegation, but its automatic rule must not
      // outlive it and fire on the owner's own later turns in that Session.
      await ready;
      await spend(
        ruleStore.activeForSession(task.sessionId).filter((rule) => rule.origin === "delegation"),
      );
      return;
    }
    if (task.status !== "completed" && task.status !== "failed") return;
    await ready;
    const event = task.status === "completed" ? "done" : "failed";
    const plan = await deliveries.plan({ sessionId: task.sessionId, event, task });
    // A plan for a task opens with its closure entry.
    const delivery = plan.entries[0]!;
    const title =
      textLine(deps.sessionTitle(task.sessionId), MAX_TITLE) ?? textLine(task.objective, MAX_TITLE);
    const summary = textLine(task.resultSummary ?? task.summary, MAX_SUMMARY);
    const error = textLine(task.lastError, MAX_ERROR);
    const body = closure.text?.trim();
    const media = parseNoticeMedia(closure.media);
    await deps.submit({
      kind: event === "done" ? "session.done" : "session.failed",
      priority: "P1",
      // Per attempt: a retried attempt that fails again must notify again.
      dedupeKey: `task:${task.id}:${task.attempt}:${task.status}`,
      sessionId: task.sessionId,
      ruleIds: delivery.ruleIds,
      attention: delivery.attention,
      channel: delivery.channel,
      target: delivery.target,
      facts: {
        ...(title ? { title } : {}),
        ...(summary ? { summary } : {}),
        ...(error ? { error } : {}),
      },
      ...(body ? { body } : {}),
      // The owner asked for this over IM: their answer is never held back.
      ...(delivery.reply ? { reply: true } : {}),
      ...(media ? { media } : {}),
    });
    // This notice satisfies every Session rule that was waiting for the outcome.
    await spend(plan.rules);
  }

  return { notifyTaskClosed, armDelegationRule };
}
