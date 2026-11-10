import { beforeEach, describe, expect, test } from "bun:test";
import type { ConversationSessionRoute, PetLongTask } from "@cjhyy/code-shell-pet";
import type { NoticeEvent } from "@cjhyy/code-shell-pet/protocol";
import { createPetDeliveryResolver, type DeliveryPlanEntry } from "./pet-delivery-plan.js";
import type { NoticeRule, NoticeRulePatch } from "./pet-rule-store.js";
import { PetRuleStoreError } from "./pet-rule-store.js";
import type { DesktopPendingDecision, DesktopPetProjectionEvent } from "./pet-state-aggregator.js";
import { PetSessionRuleWatcher, type NoticeDraft } from "./pet-session-rule-watcher.js";
import { SessionOutcomeDeriver } from "./session-outcome.js";

const SID = "s-work";
const NOW = 1_700_000_000_000;

class FakeRules {
  rules: NoticeRule[] = [];
  updates: { id: string; expectedVersion: number; patch: NoticeRulePatch }[] = [];
  failUpdate: Error | undefined;

  activeForSession(sessionId: string): NoticeRule[] {
    const result = this.rules.filter(
      (rule) =>
        rule.state === "active" &&
        rule.when.kind === "session" &&
        rule.when.sessionId === sessionId,
    );
    const system = this.rules.find((rule) => rule.when.kind === "all-sessions");
    if (system?.state === "active") result.push(system);
    return result.map((rule) => structuredClone(rule));
  }

  async update(id: string, expectedVersion: number, patch: NoticeRulePatch): Promise<NoticeRule> {
    this.updates.push({ id, expectedVersion, patch });
    if (this.failUpdate) throw this.failUpdate;
    const rule = this.rules.find((candidate) => candidate.id === id);
    if (!rule) throw new PetRuleStoreError("rule_not_found");
    if (rule.version !== expectedVersion) throw new PetRuleStoreError("version_conflict");
    if (patch.state) rule.state = patch.state;
    rule.version += 1;
    return structuredClone(rule);
  }
}

function sessionRule(
  id: string,
  overrides: {
    sessionId?: string;
    events?: NoticeEvent[];
    scope?: "turn" | "goal";
    armedAt?: number;
    state?: NoticeRule["state"];
  } = {},
): NoticeRule {
  return {
    id,
    version: 1,
    origin: "user",
    createdBy: "notify-me",
    when: {
      kind: "session",
      sessionId: overrides.sessionId ?? SID,
      runtime: "native",
      events: overrides.events ?? ["done", "failed", "blocked"],
      scope: overrides.scope ?? "turn",
      armedAt: overrides.armedAt ?? NOW - 1_000,
    },
    then: { mode: "notify" },
    attention: "always",
    channel: "auto",
    target: { kind: "owner" },
    state: overrides.state ?? "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function systemRule(events: NoticeEvent[] = ["done", "failed", "blocked"]): NoticeRule {
  return {
    id: "all-sessions",
    version: 1,
    origin: "system",
    createdBy: "system",
    when: { kind: "all-sessions", events, onlyWhenAway: true },
    then: { mode: "notify" },
    attention: "always",
    channel: "auto",
    target: { kind: "owner" },
    state: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const started = (extra: Record<string, unknown> = {}) => ({
  type: "session_started",
  sessionId: SID,
  runId: "run-1",
  clientMessageId: "cm-1",
  promptTokens: 0,
  ...extra,
});
const tool = (toolName: string) => ({
  type: "tool_use_start",
  toolCall: { id: `t-${toolName}`, toolName, args: {} },
});
const done = (extra: Record<string, unknown> = {}) => ({
  type: "turn_complete",
  reason: "completed",
  text: "  All tests pass now.  ",
  ...extra,
});
const goal = (status: string, extra: Record<string, unknown> = {}) => ({
  type: "goal_progress",
  status,
  round: 1,
  ...extra,
});

function pending(overrides: Partial<DesktopPendingDecision> = {}): DesktopPendingDecision {
  return {
    agentSessionId: SID,
    requestId: "req-1",
    workerGeneration: 1,
    kind: "ask_user",
    title: "需要用户回答",
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    status: "pending",
    ...overrides,
  };
}

function pendingUpsert(value: DesktopPendingDecision): DesktopPetProjectionEvent {
  return { kind: "pending-upsert", pending: value, version: 1, generation: 1, observedAt: NOW };
}

let rules: FakeRules;
/**
 * Drafts as emitted, with what their delivery says about rules spelled out
 * (the delivery itself is kept in `deliveries`, same order).
 */
let drafts: Array<Omit<NoticeDraft, "delivery"> & { ruleIds: string[]; requiresAway?: boolean }>;
let deliveries: DeliveryPlanEntry[];
/** Long tasks the delivery plan knows (closed ones included). */
let tasks: PetLongTask[];
/** IM conversations that receive the Session's turn replies. */
let replyRoutes: ConversationSessionRoute[];
let logs: { event: string; data: Record<string, unknown> }[];
let longTask: boolean;
let busy: boolean;
let eligible: boolean;
let clock: number;

function watcher(
  extra: Partial<ConstructorParameters<typeof PetSessionRuleWatcher>[0]> = {},
): PetSessionRuleWatcher {
  return new PetSessionRuleWatcher({
    rules,
    deliveries: createPetDeliveryResolver({
      rules,
      longTasks: {
        activeForSession: (sessionId) =>
          longTask ? ({ id: "task-active", sessionId } as PetLongTask) : undefined,
        getSnapshot: () => ({ tasks }),
      },
      replyRoutes: async () => replyRoutes,
      delegatedFromDesktop: () => "auto",
    }),
    onNotice: ({ delivery, ...draft }) => {
      const { kind, priority, dedupeKey, sessionId, ...rest } = draft;
      drafts.push({
        kind,
        priority,
        dedupeKey,
        sessionId,
        ruleIds: delivery.ruleIds,
        ...(delivery.requiresAway ? { requiresAway: true } : {}),
        ...rest,
      });
      deliveries.push(delivery);
    },
    onPendingDecision: () => undefined,
    isSessionBusy: () => busy,
    isEligibleSession: () => eligible,
    sessionTitle: (sessionId) => (sessionId === SID ? "修复登录" : undefined),
    now: () => clock,
    log: (event, data) => logs.push({ event, data }),
    ...extra,
  });
}

const derivers = new WeakMap<PetSessionRuleWatcher, SessionOutcomeDeriver>();

/** Feed one raw stream event the way the main-process tap does: interpreted once. */
function observe(w: PetSessionRuleWatcher, sessionId: string, event: unknown): Promise<void> {
  let deriver = derivers.get(w);
  if (!deriver) derivers.set(w, (deriver = new SessionOutcomeDeriver({ now: () => clock })));
  return w.observe(sessionId, deriver.derive(sessionId, event));
}

async function feed(w: PetSessionRuleWatcher, events: unknown[], sessionId = SID): Promise<void> {
  for (const event of events) await observe(w, sessionId, event);
}

beforeEach(() => {
  rules = new FakeRules();
  drafts = [];
  deliveries = [];
  tasks = [];
  replyRoutes = [];
  logs = [];
  longTask = false;
  busy = false;
  eligible = true;
  clock = NOW;
});

describe("turn-scope done", () => {
  test("a completed turn with real work emits one done draft and spends the rule", async () => {
    rules.rules.push(sessionRule("rule-a"));
    const w = watcher();
    await feed(w, [started(), tool("Bash"), done()]);
    expect(drafts).toEqual([
      {
        kind: "session.done",
        priority: "P1",
        dedupeKey: `${SID}:turn:run-1`,
        sessionId: SID,
        ruleIds: ["rule-a"],
        facts: { title: "修复登录", summary: "All tests pass now." },
      },
    ]);
    expect(rules.rules[0]!.state).toBe("spent");
  });

  test("summary is capped", async () => {
    rules.rules.push(sessionRule("rule-a"));
    const w = watcher();
    await feed(w, [started(), tool("Bash"), done({ text: "x".repeat(5_000) })]);
    expect(drafts[0]!.facts.summary!.length).toBe(2_000);
  });

  test("the acknowledgement turn (only NotifyMe) does not fire; the next working turn does", async () => {
    const w = watcher();
    await feed(w, [started(), tool("NotifyMe")]);
    // NotifyMe arms the rule mid-turn, so this very turn completes after armedAt.
    rules.rules.push(sessionRule("rule-a", { armedAt: NOW }));
    clock = NOW + 1_000;
    await feed(w, [tool("AskUserQuestion"), tool("ReportToMimi"), done()]);
    expect(drafts).toEqual([]);
    expect(rules.rules[0]!.state).toBe("active");
    await feed(w, [started({ runId: "run-2", clientMessageId: "cm-2" }), tool("Edit"), done()]);
    expect(drafts.map((draft) => draft.dedupeKey)).toEqual([`${SID}:turn:run-2`]);
  });

  test("ignored tools are all excluded from work detection", async () => {
    rules.rules.push(sessionRule("rule-a"));
    const w = watcher();
    await feed(w, [
      started(),
      ...[
        "NotifyMe",
        "ReportToMimi",
        "AskUserQuestion",
        "AskUserQuestionAsync",
        "RequestMimiDelivery",
      ].map(tool),
      done(),
    ]);
    expect(drafts).toEqual([]);
  });

  test("a turn woken by a background-task completion counts as work", async () => {
    rules.rules.push(sessionRule("rule-a"));
    const w = watcher();
    await feed(w, [
      started(),
      tool("NotifyMe"),
      done({ completionKind: "background_wait" }),
      // Background wake: a synthetic run with no client message id.
      started({ runId: "run-2", previousRunId: "run-1", clientMessageId: undefined }),
      done({ text: "Build finished" }),
    ]);
    expect(drafts.map((draft) => [draft.kind, draft.dedupeKey, draft.facts.summary])).toEqual([
      ["session.done", `${SID}:turn:run-2`, "Build finished"],
    ]);
  });

  test("work flags reset between turns", async () => {
    rules.rules.push(sessionRule("rule-a"));
    const w = watcher();
    await feed(w, [started(), tool("Bash"), done({ reason: "aborted_streaming" })]);
    await feed(w, [started({ runId: "run-2", clientMessageId: "cm-2" }), done()]);
    expect(drafts).toEqual([]);
  });

  test("a busy session does not fire and stays armed", async () => {
    rules.rules.push(sessionRule("rule-a"));
    busy = true;
    const w = watcher();
    await feed(w, [started(), tool("Bash"), done()]);
    expect(drafts).toEqual([]);
    expect(rules.rules[0]!.state).toBe("active");
    busy = false;
    await feed(w, [started({ runId: "run-2", clientMessageId: "cm-2" }), tool("Bash"), done()]);
    expect(drafts.map((draft) => draft.dedupeKey)).toEqual([`${SID}:turn:run-2`]);
  });

  test("rules armed after this turn, goal-scope rules and rules without done do not match", async () => {
    rules.rules.push(
      sessionRule("rule-future", { armedAt: NOW + 1 }),
      sessionRule("rule-goal", { scope: "goal" }),
      sessionRule("rule-failed-only", { events: ["failed"] }),
      sessionRule("rule-other", { sessionId: "s-other" }),
      sessionRule("rule-match"),
    );
    const w = watcher();
    await feed(w, [started(), tool("Bash"), done()]);
    expect(drafts.map((draft) => draft.ruleIds)).toEqual([["rule-match"]]);
  });

  test("background_wait, goal_control_stop and aborts do not emit", async () => {
    rules.rules.push(sessionRule("rule-a"));
    const w = watcher();
    for (const event of [
      done({ completionKind: "background_wait" }),
      done({ completionKind: "goal_control_stop" }),
      done({ reason: "aborted_streaming" }),
      done({ reason: "aborted_tools" }),
    ]) {
      await feed(w, [started(), tool("Bash"), event]);
    }
    expect(drafts).toEqual([]);
    expect(rules.rules[0]!.state).toBe("active");
  });

  test("child agent events are ignored", async () => {
    rules.rules.push(sessionRule("rule-a"));
    const w = watcher();
    await feed(w, [started(), { ...tool("Bash"), agentId: "child" }, done()]);
    expect(drafts).toEqual([]);
    await feed(w, [started(), tool("Bash"), { ...done(), agentId: "child" }]);
    expect(drafts).toEqual([]);
  });
});

describe("goal scope", () => {
  test("goal_progress(met) fires goal-scope rules with the goal id as key", async () => {
    rules.rules.push(
      sessionRule("rule-goal", { scope: "goal" }),
      sessionRule("rule-turn", { events: ["failed"] }),
    );
    const w = watcher();
    await feed(w, [started(), tool("Bash"), goal("met", { goalId: "g-1" })]);
    expect(drafts).toEqual([
      {
        kind: "session.done",
        priority: "P1",
        dedupeKey: `${SID}:goal:g-1`,
        sessionId: SID,
        ruleIds: ["rule-goal"],
        facts: { title: "修复登录" },
      },
    ]);
    expect(rules.rules[0]!.state).toBe("spent");
  });

  test("goal met without a goal id falls back to the run id", async () => {
    rules.rules.push(sessionRule("rule-goal", { scope: "goal" }));
    const w = watcher();
    await feed(w, [started(), goal("met")]);
    expect(drafts[0]!.dedupeKey).toBe(`${SID}:goal:run-1`);
  });

  test("goal_cleared cancels goal-scope rules only and emits nothing", async () => {
    rules.rules.push(
      sessionRule("rule-goal", { scope: "goal" }),
      sessionRule("rule-turn", { scope: "turn" }),
    );
    const w = watcher();
    await feed(w, [
      started(),
      { type: "goal_cleared", goalId: "g-1" },
      done({ completionKind: "goal_control_stop" }),
    ]);
    expect(drafts).toEqual([]);
    expect(rules.rules.map((rule) => rule.state)).toEqual(["cancelled", "active"]);
  });

  test("goal met plus the closing turn notify the system rule only once", async () => {
    rules.rules.push(sessionRule("rule-goal", { scope: "goal" }), systemRule());
    const w = watcher();
    await feed(w, [started(), tool("Bash"), goal("met", { goalId: "g-1" }), done()]);
    expect(drafts.map((draft) => [draft.dedupeKey, draft.ruleIds, draft.requiresAway])).toEqual([
      [`${SID}:goal:g-1`, ["rule-goal", "all-sessions"], undefined],
    ]);
  });
});

describe("blocked", () => {
  test("limit_stop emits a P0 blocked draft and keeps the rule armed", async () => {
    rules.rules.push(sessionRule("rule-a"));
    const w = watcher();
    await feed(w, [started(), tool("Bash"), done({ completionKind: "limit_stop" })]);
    expect(drafts).toEqual([
      {
        kind: "session.blocked",
        priority: "P0",
        dedupeKey: `${SID}:goal-pause:-:-:run-1`,
        sessionId: SID,
        ruleIds: ["rule-a"],
        facts: { title: "修复登录", summary: "All tests pass now." },
      },
    ]);
    expect(rules.rules[0]!.state).toBe("active");
    expect(rules.updates).toEqual([]);
  });

  test("goal waiting for the user emits blocked with the question and revision key", async () => {
    rules.rules.push(sessionRule("rule-a", { scope: "goal" }));
    const w = watcher();
    await feed(w, [
      started(),
      goal("not_met", { goalId: "g-1", revision: 3, waitingForUser: "Which database?" }),
    ]);
    expect(drafts).toEqual([
      {
        kind: "session.blocked",
        priority: "P0",
        dedupeKey: `${SID}:goal-pause:g-1:3:run-1`,
        sessionId: SID,
        ruleIds: ["rule-a"],
        facts: { title: "修复登录", question: "Which database?" },
      },
    ]);
  });

  test("defensive: a bare waitingForUser flag also counts as blocked", async () => {
    // Core sends the question string; a boolean is accepted in case a producer simplifies it.
    rules.rules.push(sessionRule("rule-a"));
    const w = watcher();
    await feed(w, [goal("not_met", { waitingForUser: true })]);
    expect(drafts.map((draft) => [draft.kind, draft.facts.question])).toEqual([
      ["session.blocked", undefined],
    ]);
  });

  test("goal exhausted emits blocked; plain not_met does not", async () => {
    rules.rules.push(sessionRule("rule-a"));
    const w = watcher();
    await feed(w, [goal("not_met", { gaps: "more" }), goal("approaching_limit")]);
    expect(drafts).toEqual([]);
    await feed(w, [goal("exhausted", { gaps: "ran out", runId: "run-7" })]);
    expect(drafts.map((draft) => [draft.kind, draft.dedupeKey])).toEqual([
      ["session.blocked", `${SID}:goal-pause:-:-:run-7`],
    ]);
  });

  test("blocked still emits while a long task owns the session", async () => {
    rules.rules.push(sessionRule("rule-a"));
    longTask = true;
    const w = watcher();
    await feed(w, [started(), tool("Bash"), done({ completionKind: "limit_stop" })]);
    expect(drafts.map((draft) => draft.kind)).toEqual(["session.blocked"]);
  });

  test("rules without blocked do not match", async () => {
    rules.rules.push(sessionRule("rule-a", { events: ["done"] }));
    const w = watcher();
    await feed(w, [done({ completionKind: "limit_stop" })]);
    await w.observeProjection(pendingUpsert(pending()));
    expect(drafts).toEqual([]);
  });
});

describe("failed", () => {
  test("a non-completed, non-abort turn emits failed and spends", async () => {
    rules.rules.push(sessionRule("rule-a"));
    const w = watcher();
    await feed(w, [started(), done({ reason: "model_error", text: "" })]);
    expect(drafts).toEqual([
      {
        kind: "session.failed",
        priority: "P1",
        dedupeKey: `${SID}:failed:run-1`,
        // Pairs the notice with the bound reply that already told the chat.
        sessionId: SID,
        ruleIds: ["rule-a"],
        facts: { title: "修复登录", error: "Work session ended: model_error" },
      },
    ]);
    expect(rules.rules[0]!.state).toBe("spent");
  });

  test("an error event emits failed with its message; the trailing turn does not repeat", async () => {
    rules.rules.push(sessionRule("rule-a"));
    const w = watcher();
    await feed(w, [
      started(),
      { type: "error", error: "provider down" },
      done({ reason: "error" }),
    ]);
    expect(drafts.map((draft) => [draft.kind, draft.dedupeKey, draft.facts.error])).toEqual([
      ["session.failed", `${SID}:failed:run-1`, "provider down"],
    ]);
  });

  test("rules without failed do not match", async () => {
    rules.rules.push(sessionRule("rule-a", { events: ["done"] }));
    const w = watcher();
    await feed(w, [{ type: "error", error: "boom" }]);
    expect(drafts).toEqual([]);
  });
});

describe("a completion kind this host does not know", () => {
  test("reports nothing, spends nothing and keeps carried work for the next turn", async () => {
    rules.rules.push(sessionRule("rule-a"));
    const w = watcher();
    await feed(w, [started(), tool("Bash"), done({ completionKind: "handed_off" })]);
    expect(drafts).toEqual([]);
    expect(rules.rules[0]!.state).toBe("active");
    // Work deferred from a busy turn is still reported by the turn after it.
    busy = true;
    await feed(w, [started({ runId: "run-2" }), tool("Bash"), done()]);
    busy = false;
    await feed(w, [started({ runId: "run-3" }), done({ completionKind: "handed_off" })]);
    expect(drafts).toEqual([]);
    await feed(w, [started({ runId: "run-4" }), done()]);
    expect(drafts.map((draft) => draft.dedupeKey)).toEqual([`${SID}:turn:run-4`]);
  });
});

describe("long task ownership", () => {
  test("done and failed are left to the long-task closure path", async () => {
    rules.rules.push(sessionRule("rule-a"));
    longTask = true;
    const w = watcher();
    await feed(w, [started(), tool("Bash"), done()]);
    await feed(w, [goal("met")]);
    await feed(w, [{ type: "error", error: "boom" }]);
    await feed(w, [done({ reason: "model_error" })]);
    expect(drafts).toEqual([]);
    expect(rules.rules[0]!.state).toBe("active");
  });

  test("a closed task still owns the run it closed, and no later run", async () => {
    rules.rules.push(sessionRule("rule-a"));
    tasks.push({
      id: "task-1",
      sessionId: SID,
      runId: "run-1",
      status: "completed",
    } as PetLongTask);
    const w = watcher();
    await feed(w, [started(), tool("Bash"), done()]);
    expect(drafts).toEqual([]);
    expect(rules.rules[0]!.state).toBe("active");
    await feed(w, [started({ runId: "run-2" }), tool("Bash"), done()]);
    expect(drafts.map((draft) => draft.dedupeKey)).toEqual([`${SID}:turn:run-2`]);
    expect(deliveries.map((delivery) => delivery.composeBy)).toEqual(["template"]);
  });

  test("a Session bound to an IM chat: the draft says its reply is the delivery", async () => {
    rules.rules.push(sessionRule("rule-a"));
    replyRoutes.push({
      id: "route-1",
      channel: "wechat",
      target: "chat-1",
      senderId: "owner-1",
      sessionId: SID,
      mode: "bound",
      status: "active",
    } as ConversationSessionRoute);
    const w = watcher();
    // Core gave no run id: the plan does not need one to know who is served.
    await feed(w, [tool("Bash"), done()]);
    expect(drafts.map((draft) => [draft.kind, draft.ruleIds])).toEqual([
      ["session.done", ["rule-a"]],
    ]);
    expect(deliveries).toMatchObject([
      { composeBy: "session-reply", target: { kind: "owner" }, channel: "auto" },
    ]);
    expect(rules.rules[0]!.state).toBe("spent");
  });
});

describe("reports raised before the run closes, in a bound Session", () => {
  const route = {
    id: "route-1",
    channel: "wechat",
    target: "chat-1",
    senderId: "owner-1",
    sessionId: SID,
    mode: "bound",
    status: "active",
  } as ConversationSessionRoute;

  test("a met Goal waits for the closing outcome, which says whether a reply serves it", async () => {
    for (const [text, composeBy] of [
      ["目标完成", "session-reply"],
      ["", "template"],
    ] as const) {
      rules.rules = [sessionRule("rule-g", { scope: "goal" }), systemRule()];
      drafts = [];
      deliveries = [];
      replyRoutes = [route];
      const w = watcher();
      await feed(w, [started(), tool("Bash"), goal("met", { goalId: "g-1" })]);
      expect(drafts).toEqual([]);
      expect(rules.rules[0]!.state).toBe("active");
      await feed(w, [done({ completionKind: "goal_control_stop", text })]);
      // One report for the turn: the system rule is not told a second time.
      expect(drafts.map((draft) => [draft.dedupeKey, draft.ruleIds])).toEqual([
        [`${SID}:goal:g-1`, ["rule-g", "all-sessions"]],
      ]);
      expect(deliveries.map((delivery) => delivery.composeBy)).toEqual([composeBy]);
      expect(rules.rules[0]!.state).toBe("spent");
    }
  });

  test("an error waits for the failing turn_complete and is reported once", async () => {
    rules.rules.push(sessionRule("rule-a"));
    replyRoutes = [route];
    const w = watcher();
    await feed(w, [started(), { type: "error", error: "provider down" }]);
    expect(drafts).toEqual([]);
    await feed(w, [done({ reason: "max_turns", text: undefined })]);
    expect(drafts.map((draft) => [draft.dedupeKey, draft.facts.error])).toEqual([
      [`${SID}:failed:run-1`, "provider down"],
    ]);
    expect(deliveries.map((delivery) => delivery.composeBy)).toEqual(["template"]);
  });

  test("a turn that never closed is reported when the next one starts reporting", async () => {
    rules.rules.push(sessionRule("rule-g", { scope: "goal" }), sessionRule("rule-t"));
    replyRoutes = [route];
    const w = watcher();
    await feed(w, [started(), goal("met", { goalId: "g-1" })]);
    // The worker went away; a new run of the Session completes.
    await feed(w, [started({ runId: "run-2" }), tool("Bash"), done()]);
    expect(drafts.map((draft) => draft.dedupeKey)).toEqual([
      `${SID}:goal:g-1`,
      `${SID}:turn:run-2`,
    ]);
    expect(deliveries.map((delivery) => delivery.composeBy)).toEqual(["template", "session-reply"]);
  });

  test("flush() reports parked runs as not forwarded, once, and leaves others alone", async () => {
    rules.rules.push(sessionRule("rule-g", { scope: "goal" }));
    rules.rules.push(sessionRule("rule-o", { sessionId: "s-other", scope: "goal" }));
    replyRoutes = [route, { ...route, id: "route-2", sessionId: "s-other" }];
    const w = watcher();
    await feed(w, [started(), goal("met", { goalId: "g-1" })]);
    await feed(w, [started({ sessionId: "s-other" }), goal("met", { goalId: "g-2" })], "s-other");
    expect(drafts).toEqual([]);
    expect(w.hasPending()).toBe(true);
    // The worker went away: one Session first, then everything.
    await w.flush(SID);
    expect(drafts.map((draft) => draft.dedupeKey)).toEqual([`${SID}:goal:g-1`]);
    expect(deliveries.map((delivery) => delivery.composeBy)).toEqual(["template"]);
    await w.flush();
    await w.flush();
    expect(drafts.map((draft) => draft.dedupeKey)).toEqual([`${SID}:goal:g-1`, "s-other:goal:g-2"]);
    expect(w.hasPending()).toBe(false);
    expect(rules.rules.map((rule) => rule.state)).toEqual(["spent", "spent"]);
  });

  test("without a bound conversation nothing is parked", async () => {
    rules.rules.push(sessionRule("rule-g", { scope: "goal" }));
    const w = watcher();
    await feed(w, [started(), goal("met", { goalId: "g-1" })]);
    expect(drafts.map((draft) => draft.dedupeKey)).toEqual([`${SID}:goal:g-1`]);
  });
});

describe("pending decisions", () => {
  test("a pending decision is never a blocked draft: the IM decision module owns it", async () => {
    rules.rules.push(sessionRule("rule-a"));
    const handed: string[] = [];
    const w = watcher({ onPendingDecision: (sessionId) => handed.push(sessionId) });
    await w.observeProjection(pendingUpsert(pending()));
    expect(drafts).toEqual([]);
    expect(handed).toEqual([SID]);
    expect(rules.rules[0]!.state).toBe("active");
  });

  test("onPendingDecision replaces the blocked draft", async () => {
    rules.rules.push(sessionRule("rule-a"));
    const handed: [string, DesktopPendingDecision][] = [];
    const w = watcher({ onPendingDecision: (sessionId, value) => handed.push([sessionId, value]) });
    const value = pending({ kind: "tool_approval", title: "等待批准 Bash", toolName: "Bash" });
    await w.observeProjection(pendingUpsert(value));
    expect(drafts).toEqual([]);
    expect(handed).toEqual([[SID, value]]);
  });

  test("resolved pendings, pending-remove and other projection events are ignored", async () => {
    rules.rules.push(sessionRule("rule-a"));
    const w = watcher();
    await w.observeProjection(pendingUpsert(pending({ status: "resolved" })));
    await w.observeProjection({
      kind: "pending-remove",
      sessionId: SID,
      requestId: "req-1",
      version: 1,
      generation: 1,
      observedAt: NOW,
    });
    await w.observeProjection({ kind: "reset", version: 1, generation: 1, observedAt: NOW });
    expect(drafts).toEqual([]);
  });

  test("ineligible sessions never reach onPendingDecision", async () => {
    rules.rules.push(sessionRule("rule-a"));
    eligible = false;
    const handed: unknown[] = [];
    const w = watcher({ onPendingDecision: (...args) => handed.push(args) });
    await w.observeProjection(pendingUpsert(pending()));
    expect(handed).toEqual([]);
  });
});

describe("matching", () => {
  test("ineligible sessions emit nothing", async () => {
    rules.rules.push(sessionRule("rule-a"), systemRule());
    eligible = false;
    const w = watcher();
    await feed(w, [started(), tool("Bash"), done()]);
    await feed(w, [{ type: "error", error: "boom" }]);
    expect(drafts).toEqual([]);
    expect(rules.rules[0]!.state).toBe("active");
  });

  test("no rules emit nothing", async () => {
    const w = watcher();
    await feed(w, [started(), tool("Bash"), done()]);
    expect(drafts).toEqual([]);
  });

  test("only the system rule matching marks the draft requiresAway and is never spent", async () => {
    rules.rules.push(systemRule());
    const w = watcher();
    await feed(w, [started(), tool("Bash"), done()]);
    expect(drafts.map((draft) => [draft.ruleIds, draft.requiresAway])).toEqual([
      [["all-sessions"], true],
    ]);
    expect(rules.updates).toEqual([]);
    expect(rules.rules[0]!.state).toBe("active");
  });

  test("a session rule plus the system rule produce one draft without requiresAway", async () => {
    rules.rules.push(sessionRule("rule-a"), systemRule());
    const w = watcher();
    await feed(w, [started(), tool("Bash"), done()]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.ruleIds).toEqual(["rule-a", "all-sessions"]);
    expect(drafts[0]!.requiresAway).toBeUndefined();
    expect(rules.updates.map((update) => update.id)).toEqual(["rule-a"]);
  });

  test("the system rule respects its own event list", async () => {
    rules.rules.push(systemRule(["failed"]));
    const w = watcher();
    await feed(w, [started(), tool("Bash"), done()]);
    expect(drafts).toEqual([]);
  });

  test("a failed spend still emits and is logged", async () => {
    rules.rules.push(sessionRule("rule-a"));
    rules.failUpdate = new PetRuleStoreError("version_conflict");
    const w = watcher();
    await feed(w, [started(), tool("Bash"), done()]);
    expect(drafts).toHaveLength(1);
    expect(logs).toEqual([
      {
        event: "pet.notice.rule_update_failed",
        data: { sessionId: SID, ruleId: "rule-a", state: "spent", error: "version_conflict" },
      },
    ]);
  });

  test("a throwing onNotice is logged and the rule stays armed", async () => {
    rules.rules.push(sessionRule("rule-a"));
    const w = watcher({
      onNotice: () => {
        throw new Error("router down");
      },
    });
    await feed(w, [started(), tool("Bash"), done()]);
    expect(rules.rules[0]!.state).toBe("active");
    expect(logs.map((entry) => entry.event)).toEqual(["pet.notice.emit_failed"]);
  });
});

describe("arming, dedupe keys and ordering", () => {
  test("a rule armed before a restart fires on the next completed working turn", async () => {
    // Armed a day ago by a previous app process; this watcher has never seen the Session.
    rules.rules.push(sessionRule("rule-a", { armedAt: NOW - 86_400_000 }));
    const w = watcher();
    await feed(w, [
      started({ runId: "run-after-restart", previousRunId: "run-before", clientMessageId: "cm-9" }),
      tool("Bash"),
      done(),
    ]);
    expect(drafts.map((draft) => [draft.kind, draft.dedupeKey])).toEqual([
      ["session.done", `${SID}:turn:run-after-restart`],
    ]);
    expect(rules.rules[0]!.state).toBe("spent");
  });

  test("two different runs produce different dedupe keys", async () => {
    rules.rules.push(systemRule());
    const w = watcher();
    await feed(w, [started(), tool("Bash"), done()]);
    await feed(w, [started({ runId: "run-2", clientMessageId: "cm-2" }), tool("Bash"), done()]);
    // A restarted watcher seeing a third run still never reuses an earlier key.
    await feed(watcher(), [
      started({ runId: "run-3", clientMessageId: "cm-3" }),
      tool("Bash"),
      done(),
    ]);
    expect(drafts.map((draft) => draft.dedupeKey)).toEqual([
      `${SID}:turn:run-1`,
      `${SID}:turn:run-2`,
      `${SID}:turn:run-3`,
    ]);
  });

  test("the run id carried on the terminal event wins over session_started", async () => {
    rules.rules.push(systemRule());
    const w = watcher();
    await feed(w, [started(), tool("Bash"), done({ runId: "run-on-event" })]);
    expect(drafts[0]!.dedupeKey).toBe(`${SID}:turn:run-on-event`);
  });

  test("arming compares against turn_complete.completedAt when present", async () => {
    rules.rules.push(sessionRule("rule-late", { armedAt: NOW + 500 }));
    const w = watcher();
    // The turn finished before the rule was armed, even if observed later.
    clock = NOW + 1_000;
    await feed(w, [started(), tool("Bash"), done({ completedAt: NOW + 100 })]);
    expect(drafts).toEqual([]);
    await feed(w, [
      started({ runId: "run-2", clientMessageId: "cm-2" }),
      tool("Bash"),
      done({ completedAt: NOW + 900 }),
    ]);
    expect(drafts.map((draft) => draft.ruleIds)).toEqual([["rule-late"]]);
  });

  test("arming falls back to now() without completedAt", async () => {
    rules.rules.push(sessionRule("rule-late", { armedAt: NOW + 500 }));
    const w = watcher();
    await feed(w, [started(), tool("Bash"), done()]);
    expect(drafts).toEqual([]);
    clock = NOW + 500;
    await feed(w, [started({ runId: "run-2", clientMessageId: "cm-2" }), tool("Bash"), done()]);
    expect(drafts.map((draft) => draft.ruleIds)).toEqual([["rule-late"]]);
  });

  test("without any run id the key falls back to completedAt, then now()", async () => {
    rules.rules.push(systemRule());
    const w = watcher();
    await feed(w, [tool("Bash"), done({ completedAt: NOW + 42 })]);
    clock = NOW + 7;
    await feed(w, [tool("Bash"), done()]);
    expect(drafts.map((draft) => draft.dedupeKey)).toEqual([
      `${SID}:turn:${NOW + 42}`,
      `${SID}:turn:${NOW + 7}`,
    ]);
  });

  test("a pending decision raised before the rule was armed is still reported", async () => {
    // The Session is blocked right now; arming only gates on when we observe it.
    rules.rules.push(sessionRule("rule-a", { armedAt: NOW }));
    const w = watcher();
    const handed: string[] = [];
    const w2 = watcher({ onPendingDecision: (sessionId) => handed.push(sessionId) });
    await w.observeProjection(pendingUpsert(pending({ createdAt: NOW - 60_000 })));
    await w2.observeProjection(pendingUpsert(pending({ createdAt: NOW - 60_000 })));
    expect(drafts).toEqual([]);
    expect(handed).toEqual([SID]);
  });

  test("events for one session are processed in order even when not awaited", async () => {
    rules.rules.push(sessionRule("rule-a"));
    const w = watcher();
    await Promise.all([
      observe(w, SID, started()),
      observe(w, SID, tool("Bash")),
      observe(w, SID, done()),
    ]);
    expect(drafts.map((draft) => draft.dedupeKey)).toEqual([`${SID}:turn:run-1`]);
  });

  test("malformed events are ignored", async () => {
    rules.rules.push(systemRule());
    const w = watcher();
    for (const event of [null, 3, "x", [], {}, { type: 5 }]) await observe(w, SID, event);
    expect(drafts).toEqual([]);
  });
});

describe("core's real flows", () => {
  test("a Goal waiting for the user parks with a completed turn: blocked only", async () => {
    rules.rules.push(sessionRule("rule-a"), systemRule());
    const w = watcher();
    await feed(w, [
      started(),
      tool("Bash"),
      goal("not_met", { goalId: "g-1", revision: 1, waitingForUser: "Ship it?" }),
      // turn-loop parks the run with an ordinary completion, no completionKind.
      done({ text: "Waiting for your answer" }),
    ]);
    expect(drafts.map((draft) => [draft.kind, draft.ruleIds])).toEqual([
      ["session.blocked", ["rule-a", "all-sessions"]],
    ]);
    expect(rules.rules[0]!.state).toBe("active");
  });

  test("an exhausted Goal parked with a completed turn is blocked, not done", async () => {
    rules.rules.push(sessionRule("rule-a"));
    const w = watcher();
    await feed(w, [started(), tool("Bash"), goal("exhausted", { gaps: "tests" }), done()]);
    expect(drafts.map((draft) => draft.kind)).toEqual(["session.blocked"]);
    expect(rules.rules[0]!.state).toBe("active");
  });

  test("the user's reply after a Goal pause can then complete the work", async () => {
    rules.rules.push(sessionRule("rule-a"));
    const w = watcher();
    await feed(w, [started(), tool("Bash"), goal("not_met", { waitingForUser: "Q?" }), done()]);
    await feed(w, [started({ runId: "run-2", clientMessageId: "cm-2" }), tool("Edit"), done()]);
    expect(drafts.map((draft) => [draft.kind, draft.dedupeKey])).toEqual([
      ["session.blocked", `${SID}:goal-pause:-:-:run-1`],
      ["session.done", `${SID}:turn:run-2`],
    ]);
  });

  test("a SendMessageToSession run on an idle Session is a user turn, not a wake", async () => {
    rules.rules.push(sessionRule("rule-a"));
    const w = watcher();
    await feed(w, [started(), tool("NotifyMe"), done()]);
    const delivered = { runId: "run-2", previousRunId: "run-1", clientMessageId: undefined };
    await feed(w, [
      { type: "session_user_message", text: "status?" },
      started(delivered),
      done({ text: "Still on it" }),
    ]);
    expect(drafts).toEqual([]);
    // Without the announcing session_user_message the same run is a background wake.
    await feed(w, [started({ ...delivered, runId: "run-3", previousRunId: "run-2" }), done()]);
    expect(drafts.map((draft) => draft.dedupeKey)).toEqual([`${SID}:turn:run-3`]);
  });

  test("a SendMessageToSession message queued behind a running turn is still a user turn", async () => {
    rules.rules.push(systemRule());
    const w = watcher();
    await feed(w, [
      started(),
      tool("NotifyMe"),
      // Announced while run-1 is still running; its run starts after run-1 ends.
      { type: "session_user_message", text: "and also this" },
      done(),
      started({ runId: "run-2", previousRunId: "run-1", clientMessageId: undefined }),
      done(),
    ]);
    expect(drafts).toEqual([]);
  });

  test("core's trigger marker wins over the queued-message counter", async () => {
    rules.rules.push(systemRule());
    const w = watcher();
    await feed(w, [started(), tool("NotifyMe"), done()]);
    // A host message is announced, but a background wake starts first.
    await feed(w, [
      { type: "session_user_message", text: "status?" },
      started({
        runId: "run-2",
        previousRunId: "run-1",
        clientMessageId: undefined,
        trigger: "background_wake",
      }),
      done(),
    ]);
    expect(drafts.map((draft) => draft.dedupeKey)).toEqual([`${SID}:turn:run-2`]);
    // The announced message's run is still a user turn: the wake did not eat it.
    await feed(w, [
      started({
        runId: "run-3",
        previousRunId: "run-2",
        clientMessageId: undefined,
        trigger: "host_message",
      }),
      done({ text: "Still on it" }),
    ]);
    expect(drafts).toHaveLength(1);
  });

  test("a run core marks as user-triggered is never a wake, even unannounced", async () => {
    rules.rules.push(sessionRule("rule-a"));
    const w = watcher();
    await feed(w, [started(), tool("NotifyMe"), done()]);
    await feed(w, [
      started({
        runId: "run-2",
        previousRunId: "run-1",
        clientMessageId: undefined,
        trigger: "user",
      }),
      done({ text: "ok" }),
    ]);
    expect(drafts).toEqual([]);
  });

  test("a delivered user turn that does work still fires", async () => {
    rules.rules.push(sessionRule("rule-a"));
    const w = watcher();
    await feed(w, [
      { type: "session_user_message", text: "fix it" },
      started({ runId: "run-2", previousRunId: "run-1", clientMessageId: undefined }),
      tool("Bash"),
      done(),
    ]);
    expect(drafts.map((draft) => draft.dedupeKey)).toEqual([`${SID}:turn:run-2`]);
  });

  test("a replayed goal_progress(met) from before the rule was armed does not fire it", async () => {
    rules.rules.push(sessionRule("rule-goal", { scope: "goal", armedAt: NOW }));
    const w = watcher();
    clock = NOW + 10_000;
    await feed(w, [goal("met", { goalId: "g-old", timestamp: NOW - 5_000 })]);
    expect(drafts).toEqual([]);
    await feed(w, [goal("met", { goalId: "g-new", timestamp: NOW + 1 })]);
    expect(drafts.map((draft) => draft.dedupeKey)).toEqual([`${SID}:goal:g-new`]);
  });

  test("an error event older than the rule does not fire it", async () => {
    rules.rules.push(sessionRule("rule-a", { armedAt: NOW }));
    const w = watcher();
    clock = NOW + 10_000;
    await feed(w, [{ type: "error", error: "old", timestamp: NOW - 1 }]);
    expect(drafts).toEqual([]);
  });

  test("ToolSearch to load NotifyMe is not work", async () => {
    rules.rules.push(sessionRule("rule-a"));
    const w = watcher();
    await feed(w, [started(), tool("ToolSearch"), tool("NotifyMe"), done({ text: "OK" })]);
    expect(drafts).toEqual([]);
    expect(rules.rules[0]!.state).toBe("active");
  });

  test("work deferred by a busy Session is reported by the follow-up turn", async () => {
    rules.rules.push(systemRule());
    busy = true;
    const w = watcher();
    await feed(w, [started(), tool("Bash"), done()]);
    expect(drafts).toEqual([]);
    busy = false;
    // The queued follow-up needs no tools of its own.
    await feed(w, [started({ runId: "run-2", clientMessageId: "cm-2" }), done()]);
    // The carried work is consumed: a later idle turn without work stays quiet.
    await feed(w, [started({ runId: "run-3", clientMessageId: "cm-3" }), done()]);
    expect(drafts.map((draft) => draft.dedupeKey)).toEqual([`${SID}:turn:run-2`]);
  });

  test("an aborted follow-up drops the deferred work", async () => {
    rules.rules.push(systemRule());
    busy = true;
    const w = watcher();
    await feed(w, [started(), tool("Bash"), done()]);
    busy = false;
    await feed(w, [
      started({ runId: "run-2", clientMessageId: "cm-2" }),
      done({ reason: "aborted_streaming" }),
      started({ runId: "run-3", clientMessageId: "cm-3" }),
      done(),
    ]);
    expect(drafts).toEqual([]);
  });

  test("observe never rejects; failures are logged", async () => {
    const w = watcher({
      deliveries: {
        plan: async () => {
          throw new Error("store gone");
        },
      },
    });
    await expect(feed(w, [started(), tool("Bash"), done()])).resolves.toBeUndefined();
    expect(logs).toEqual([
      { event: "pet.notice.observe_failed", data: { sessionId: SID, error: "store gone" } },
    ]);
  });
});
