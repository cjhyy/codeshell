/**
 * Who must be told about a work Session's outcome: the one place that answers
 * it. Three sources say who is waiting for a Session — its active notice
 * rules, the long task that owns the run (its origin conversation), and the IM
 * conversations the Session is bound to. Only this module reads them for that
 * purpose; the rule watcher, the long-task closure, the IM decision prompts
 * and the bound-Session bridge all take their targets from a plan built here.
 *
 * A plan is a list of entries, one per message somebody receives:
 *
 * | who is waiting                            | entry                                   |
 * | ----------------------------------------- | --------------------------------------- |
 * | a long task owns the run (done / failed)  | one `mimi-closure` entry for the task's origin: its IM conversation (`reply: true`) or the owner. Every matching rule is folded into it (the delegation rule is the same declaration), so the watcher sends nothing for that run. |
 * | the Session is bound to an IM chat (done / failed) | one `session-reply` entry per conversation: the reply the bridge forwards IS the delivery. Rules that address that conversation merge into it: no second message there. |
 * | rules only, or a run that forwards no reply | one `template` entry (`reply: true` when a WatchSession rule addressed it to the asking IM chat). |
 * | a pending decision in an IM-started task (blocked) | one `template` entry for the task's origin, `reply: true`. |
 *
 * Rules that matched one outcome are one declaration ("tell me"), merged as
 * they always were: a rule's route outranks the owner, a named IM outranks
 * `auto` outranks `desktop`, and the strongest attention wins. An entry for
 * the owner merges into a bound conversation when its channel is `auto` or the
 * bound conversation's channel; an owner rule that names another channel stays
 * a message of its own.
 *
 * Entries are keyed by conversation identity (the rule store's
 * `noticeTargetKey`). The one pair that may share a conversation is a task's
 * closure and the Session's own reply: Mimi's summary of the task and the
 * Session's turn text are different messages.
 */

import type { ConversationSessionRoute, PetLongTask } from "@cjhyy/code-shell-pet";
import type { NoticeAttention, NoticeChannel, NoticeEvent } from "@cjhyy/code-shell-pet/protocol";
import type { NoticeTarget } from "./pet-notice-types.js";
import { noticeTargetKey, type NoticeRule } from "./pet-rule-store.js";

export interface DeliveryPlanEntry {
  /** Conversation identity; entries with the same key reach the same conversation. */
  key: string;
  /**
   * The address handed to the notice router. For a `session-reply` entry that
   * absorbed owner rules this stays the owner (the desktop record is the
   * owner's); `replyRoute` is the conversation the message itself reaches.
   */
  target: NoticeTarget;
  channel: NoticeChannel;
  attention: NoticeAttention;
  /** The rules this delivery satisfies; empty when no rule asked for it. */
  ruleIds: string[];
  /** The answer to something asked over IM: never held back. */
  reply: boolean;
  /**
   * Who writes the message: the notice template, Mimi's closure turn, or the
   * Session itself (the bridge forwards its turn reply; the router is then
   * never asked to send IM, it only keeps the desktop record).
   */
  composeBy: "template" | "mimi-closure" | "session-reply";
  /** Only the all-sessions system rule asked: deliver only while the owner is away. */
  requiresAway: boolean;
  /** `session-reply` only: the conversation the bridge forwards the reply to. */
  replyRoute?: ConversationSessionRoute;
}

export interface DeliveryPlan {
  entries: DeliveryPlanEntry[];
  /** The rules the plan was built from (a done / failed delivery spends its Session rules). */
  rules: NoticeRule[];
}

export interface DeliveryQuery {
  sessionId: string;
  event: NoticeEvent;
  /** Only Session rules armed at or before this moment (an outcome's time). Absent: any. */
  at?: number;
  /** Only Session rules of this scope. Absent: any. */
  scope?: "turn" | "goal";
  /** False leaves the all-sessions system rule out (it already heard about this turn). */
  includeSystem?: boolean;
  /** False ignores notice rules altogether (a Session rules may not watch). */
  useRules?: boolean;
  /** The run that produced a done / failed outcome, to find the long task that owns it. */
  runKey?: string;
  /**
   * False: the run closed with nothing a bound conversation is sent
   * (`SessionOutcome.reply`), so no conversation is served by a Session reply.
   * Absent: the run forwards one (or has not closed yet, and is assumed to).
   */
  replyForwarded?: boolean;
  /**
   * The long task this is about: the one whose closure is reported (done /
   * failed), or the active one a pending decision belongs to (blocked).
   */
  task?: PetLongTask;
}

export interface DeliveryPlanSources {
  rules: { activeForSession(sessionId: string): NoticeRule[] };
  longTasks: {
    activeForSession(sessionId: string): PetLongTask | undefined;
    getSnapshot(): { tasks: readonly PetLongTask[] };
  };
  /** Every IM conversation that receives the Session's turn replies (bound, left, suspended). */
  replyRoutes(sessionId: string): Promise<readonly ConversationSessionRoute[]>;
  /** Where a desktop-started delegation's result goes when no rule names a channel. */
  delegatedFromDesktop(): "auto" | "desktop";
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface PetDeliveryResolver {
  /** The delivery plan for one outcome of a Session. Never rejects. */
  plan(query: DeliveryQuery): Promise<DeliveryPlan>;
  /** A blocked plan, synchronously: a decision is never served by a Session reply. */
  planBlocked(query: Omit<DeliveryQuery, "event">): DeliveryPlan;
  /**
   * Who hears a Session's own progress report (ReportToMimi): an IM-started
   * task's origin and the conversations watching it, each once. Never rejects.
   */
  planReport(query: Pick<DeliveryQuery, "sessionId" | "task" | "useRules">): Promise<DeliveryPlan>;
  /** The conversations a Session's turn reply is forwarded to. Rejects when they cannot be read. */
  replyRoutes(sessionId: string): Promise<ConversationSessionRoute[]>;
  /**
   * Where a rule set for this Session now would notify: its bound IM chat,
   * else the IM origin of its active long task, else the owner.
   */
  ruleTarget(sessionId: string): Promise<NoticeRule["target"]>;
  /** Where a delegated task's result goes: its IM origin, else the owner. */
  taskOrigin(task: PetLongTask): Pick<DeliveryPlanEntry, "target" | "channel">;
}

const ATTENTION_RANK: Readonly<Record<NoticeAttention, number>> = {
  always: 3,
  important: 2,
  digest: 1,
  muted: 0,
};

/** One address for the rules that matched one outcome. */
export function mergeRuleAttributes(rules: readonly NoticeRule[]): {
  attention: NoticeAttention;
  channel: NoticeChannel;
  target: NoticeTarget;
} {
  let attention: NoticeAttention | undefined;
  for (const rule of rules) {
    if (attention === undefined || ATTENTION_RANK[rule.attention] > ATTENTION_RANK[attention])
      attention = rule.attention;
  }
  // A named IM is the most specific ask, then auto, then desktop only.
  const named = rules.find((rule) => rule.channel !== "auto" && rule.channel !== "desktop");
  const channel = named
    ? named.channel
    : rules.some((rule) => rule.channel === "auto")
      ? "auto"
      : rules.length > 0
        ? "desktop"
        : "auto";
  const routed = rules.find((rule) => rule.target.kind === "route");
  const target: NoticeTarget =
    routed?.target.kind === "route"
      ? { kind: "route", route: routed.target.route }
      : { kind: "owner" };
  return { attention: attention ?? "always", channel, target };
}

/** A bound conversation as a rule target. */
export function routeTarget(route: ConversationSessionRoute): NoticeRule["target"] {
  return {
    kind: "route",
    route: {
      kind: "im-gateway",
      channel: route.channel,
      target: route.target,
      senderId: route.senderId,
      // Binding is refused outside private chats (bind validator). Rules saved
      // before this flag keep isDirectMessage false: on load a binding-derived
      // route cannot be told apart from an IM task's group route (both carry a
      // sender and false), so they are not upgraded; their decision prompts stay
      // generic until NotifyMe re-arms the rule.
      isDirectMessage: true,
    },
  };
}

function taskOrigin(
  task: PetLongTask,
  fallbackChannel: NoticeChannel,
): Pick<DeliveryPlanEntry, "target" | "channel"> {
  const origin = task.completionTarget;
  return origin
    ? { target: { kind: "route", route: origin }, channel: origin.channel }
    : { target: { kind: "owner" }, channel: fallbackChannel };
}

/**
 * Mimi watches a Session for the IM conversation that asked (WatchSession):
 * its outcome answers that conversation, like an IM-started task's result.
 */
function answersIm(rule: NoticeRule): boolean {
  return rule.createdBy === "watch-session" && rule.target.kind === "route";
}

function ruleEntry(
  rules: readonly NoticeRule[],
): Omit<DeliveryPlanEntry, "composeBy" | "replyRoute"> {
  const merged = mergeRuleAttributes(rules);
  return {
    key: noticeTargetKey(merged.target),
    ...merged,
    ruleIds: rules.map((rule) => rule.id),
    reply: merged.target.kind === "route" && rules.some(answersIm),
    requiresAway: rules.every((rule) => rule.when.kind === "all-sessions"),
  };
}

function replyEntry(route: ConversationSessionRoute): DeliveryPlanEntry {
  const target = routeTarget(route);
  return {
    key: noticeTargetKey(target),
    target,
    channel: route.channel,
    attention: "always",
    ruleIds: [],
    reply: false,
    composeBy: "session-reply",
    requiresAway: false,
    replyRoute: route,
  };
}

/** Whether the Session's reply in `route` already tells whoever `entry` addresses. */
function servedByReply(
  entry: Pick<DeliveryPlanEntry, "key" | "target" | "channel">,
  route: DeliveryPlanEntry,
): boolean {
  if (entry.target.kind === "route") {
    if (entry.key === route.key) return true;
    // A route recorded without its sender (an older task origin) is the same
    // conversation when channel and chat match: binding is private-chat only.
    const { channel, target, senderId } = entry.target.route;
    return (
      !senderId?.trim() &&
      channel === route.replyRoute?.channel &&
      target === route.replyRoute.target
    );
  }
  // Binding only happens in the owner's private chats: the bound conversation
  // is the owner, unless the rule asked for a different channel by name.
  return entry.channel === "auto" || entry.channel === route.channel;
}

/**
 * The plan for one outcome, from facts already gathered (pure). `rules` are
 * the rules that matched the outcome; `task` is the long task that owns the
 * run (done / failed) or that a pending decision belongs to (blocked).
 * `replyForwarded: false` means the run closed with nothing to forward: no
 * conversation is served by a Session reply then.
 */
export function buildDeliveryPlan(input: {
  event: NoticeEvent;
  rules: readonly NoticeRule[];
  task?: PetLongTask;
  replyRoutes: readonly ConversationSessionRoute[];
  replyForwarded?: boolean;
  delegatedFromDesktop: "auto" | "desktop";
}): DeliveryPlanEntry[] {
  const { event, rules, task } = input;
  const ruleIds = rules.map((rule) => rule.id);
  if (event === "blocked") {
    // The owner asked for this task over IM: its decisions are answered there.
    if (task?.completionTarget) {
      const origin = taskOrigin(task, "auto");
      return [
        {
          key: noticeTargetKey(origin.target),
          ...origin,
          attention: "always",
          ruleIds,
          reply: true,
          composeBy: "template",
          requiresAway: false,
        },
      ];
    }
    return rules.length > 0 ? [{ ...ruleEntry(rules), composeBy: "template" }] : [];
  }
  const replies = input.replyForwarded === false ? [] : input.replyRoutes.map(replyEntry);
  if (task) {
    const origin = taskOrigin(
      task,
      rules.length > 0 ? mergeRuleAttributes(rules).channel : input.delegatedFromDesktop,
    );
    return [
      {
        key: noticeTargetKey(origin.target),
        ...origin,
        attention: "always",
        ruleIds,
        reply: task.completionTarget !== undefined,
        composeBy: "mimi-closure",
        requiresAway: false,
      },
      ...replies,
    ];
  }
  if (rules.length === 0) return replies;
  const asked = ruleEntry(rules);
  const served = replies.findIndex((route) => servedByReply(asked, route));
  if (served < 0) return [{ ...asked, composeBy: "template" }, ...replies];
  // The reply in that conversation is this delivery; the router keeps the desktop record.
  const route = replies[served]!;
  replies[served] = {
    ...asked,
    key: route.key,
    composeBy: "session-reply",
    replyRoute: route.replyRoute!,
  };
  return replies;
}

/**
 * The same IM conversation: the same identity, or the same channel and chat
 * when one side was recorded without its sender (an older task origin).
 */
export function sameConversation(a: NoticeTarget, b: NoticeTarget): boolean {
  if (a.kind !== "route" || b.kind !== "route") return a.kind === b.kind;
  if (noticeTargetKey(a) === noticeTargetKey(b)) return true;
  const left = a.route;
  const right = b.route;
  return (
    (!left.senderId?.trim() || !right.senderId?.trim()) &&
    left.channel === right.channel &&
    left.target === right.target
  );
}

/**
 * The plan for a Session's progress report (pure). A milestone reaches only
 * the IM conversations that asked about this Session: an IM-started task's
 * origin (Mimi's report turn writes that message, `composeBy:
 * "mimi-closure"`) and each conversation a WatchSession rule addresses
 * (templated). The owner's own rules, a desktop delegation and bound
 * conversations (which already get the Session's turn replies) hear
 * nothing extra. One entry per conversation; none is a `reply`.
 */
export function buildReportPlan(input: {
  rules: readonly NoticeRule[];
  task?: PetLongTask;
}): DeliveryPlanEntry[] {
  const entries: DeliveryPlanEntry[] = [];
  const add = (
    target: Extract<NoticeTarget, { kind: "route" }>,
    rule: NoticeRule | undefined,
    composeBy: DeliveryPlanEntry["composeBy"],
  ): void => {
    const existing = entries.find((entry) => sameConversation(entry.target, target));
    if (existing) {
      if (rule) existing.ruleIds.push(rule.id);
      return;
    }
    entries.push({
      key: noticeTargetKey(target),
      target,
      channel: target.route.channel,
      attention: rule?.attention ?? "always",
      ruleIds: rule ? [rule.id] : [],
      reply: false,
      composeBy,
      requiresAway: false,
    });
  };
  const origin = input.task?.completionTarget;
  if (origin) add({ kind: "route", route: origin }, undefined, "mimi-closure");
  for (const rule of input.rules)
    if (answersIm(rule) && rule.target.kind === "route" && rule.when.kind === "session")
      add({ kind: "route", route: rule.target.route }, rule, "template");
  return entries;
}

/** The one entry of a plan that notice rules asked for, if any (never a closure). */
export function ruleDelivery(plan: DeliveryPlan): DeliveryPlanEntry | undefined {
  return outcomeReporter(plan) === "rules"
    ? plan.entries.find((entry) => entry.ruleIds.length > 0)
    : undefined;
}

/**
 * Who reports a done / failed outcome, read off its plan: the long-task
 * closure (Mimi writes it), the notice rules, or nobody.
 */
export function outcomeReporter(plan: DeliveryPlan): "closure" | "rules" | "none" {
  if (plan.entries.some((entry) => entry.composeBy === "mimi-closure")) return "closure";
  return plan.entries.some((entry) => entry.ruleIds.length > 0) ? "rules" : "none";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPetDeliveryResolver(sources: DeliveryPlanSources): PetDeliveryResolver {
  const matchingRules = (query: DeliveryQuery): NoticeRule[] => {
    if (query.useRules === false) return [];
    return sources.rules.activeForSession(query.sessionId).filter((rule) => {
      if (!rule.when.events.includes(query.event)) return false;
      if (rule.when.kind !== "session") return query.includeSystem !== false;
      if (query.at !== undefined && rule.when.armedAt > query.at) return false;
      return query.scope === undefined || rule.when.scope === query.scope;
    });
  };

  // A long task owns its Session while active, and owns the run it closed.
  const owningTask = (sessionId: string, runKey: string): PetLongTask | undefined =>
    sources.longTasks.activeForSession(sessionId) ??
    sources.longTasks
      .getSnapshot()
      .tasks.find((task) => task.sessionId === sessionId && task.runId === runKey);

  const build = (
    query: DeliveryQuery,
    task: PetLongTask | undefined,
    replyRoutes: readonly ConversationSessionRoute[],
  ): DeliveryPlan => {
    const rules = matchingRules(query);
    return {
      rules,
      entries: buildDeliveryPlan({
        event: query.event,
        rules,
        ...(task ? { task } : {}),
        replyRoutes,
        ...(query.replyForwarded === false ? { replyForwarded: false } : {}),
        delegatedFromDesktop: sources.delegatedFromDesktop(),
      }),
    };
  };

  const replyRoutes = async (sessionId: string): Promise<ConversationSessionRoute[]> => [
    ...(await sources.replyRoutes(sessionId)),
  ];

  /** Unreadable routes are "none": a notice may then repeat a reply, but is never lost. */
  const replyRoutesOrNone = async (sessionId: string): Promise<ConversationSessionRoute[]> => {
    try {
      return await replyRoutes(sessionId);
    } catch (error) {
      sources.log?.("pet.notice.route_lookup_failed", { sessionId, error: errorText(error) });
      return [];
    }
  };

  const planBlocked: PetDeliveryResolver["planBlocked"] = (query) =>
    build({ ...query, event: "blocked" }, query.task, []);

  return {
    async planReport(query) {
      // Only the IM conversations that asked to watch this Session.
      const rules =
        query.useRules === false
          ? []
          : sources.rules.activeForSession(query.sessionId).filter(answersIm);
      return {
        rules,
        entries: buildReportPlan({ rules, ...(query.task ? { task: query.task } : {}) }),
      };
    },
    async plan(query) {
      if (query.event === "blocked") return planBlocked(query);
      const task =
        query.task ??
        (query.runKey !== undefined ? owningTask(query.sessionId, query.runKey) : undefined);
      return build(query, task, await replyRoutesOrNone(query.sessionId));
    },
    planBlocked,
    replyRoutes,
    async ruleTarget(sessionId) {
      const routes = await replyRoutesOrNone(sessionId);
      const bound = routes.find((route) => route.mode === "bound" && route.status === "active");
      if (bound) return routeTarget(bound);
      const origin = sources.longTasks.activeForSession(sessionId)?.completionTarget;
      return origin ? { kind: "route", route: origin } : { kind: "owner" };
    },
    taskOrigin: (task) => taskOrigin(task, sources.delegatedFromDesktop()),
  };
}
