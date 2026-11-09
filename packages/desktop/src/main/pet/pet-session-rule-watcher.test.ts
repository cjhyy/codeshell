import { beforeEach, describe, expect, test } from "bun:test";
import type { NoticeEvent } from "@cjhyy/code-shell-pet/protocol";
import type { NoticeRule, NoticeRulePatch } from "./pet-rule-store.js";
import { PetRuleStoreError } from "./pet-rule-store.js";
import type { DesktopPendingDecision, DesktopPetProjectionEvent } from "./pet-state-aggregator.js";
import { PetSessionRuleWatcher, type NoticeDraft } from "./pet-session-rule-watcher.js";

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
    armedAtSeq?: number;
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
      armedAtSeq: overrides.armedAtSeq ?? 0,
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
let drafts: NoticeDraft[];
let logs: { event: string; data: Record<string, unknown> }[];
let longTask: boolean;
let busy: boolean;
let eligible: boolean;

function watcher(
  extra: Partial<ConstructorParameters<typeof PetSessionRuleWatcher>[0]> = {},
): PetSessionRuleWatcher {
  return new PetSessionRuleWatcher({
    rules,
    onNotice: (draft) => drafts.push(draft),
    hasActiveLongTask: () => longTask,
    isSessionBusy: () => busy,
    isEligibleSession: () => eligible,
    sessionTitle: (sessionId) => (sessionId === SID ? "修复登录" : undefined),
    now: () => NOW,
    log: (event, data) => logs.push({ event, data }),
    ...extra,
  });
}

async function feed(w: PetSessionRuleWatcher, events: unknown[], sessionId = SID): Promise<void> {
  for (const event of events) await w.observe(sessionId, event);
}

beforeEach(() => {
  rules = new FakeRules();
  drafts = [];
  logs = [];
  longTask = false;
  busy = false;
  eligible = true;
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
        dedupeKey: `${SID}:turn:0`,
        sessionId: SID,
        ruleIds: ["rule-a"],
        facts: { title: "修复登录", summary: "All tests pass now." },
      },
    ]);
    expect(rules.rules[0]!.state).toBe("spent");
    expect(w.currentSeq(SID)).toBe(1);
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
    // NotifyMe arms the rule mid-turn at the current seq.
    rules.rules.push(sessionRule("rule-a", { armedAtSeq: w.currentSeq(SID) }));
    await feed(w, [tool("AskUserQuestion"), tool("ReportToMimi"), done()]);
    expect(drafts).toEqual([]);
    expect(rules.rules[0]!.state).toBe("active");
    await feed(w, [started({ runId: "run-2", clientMessageId: "cm-2" }), tool("Edit"), done()]);
    expect(drafts.map((draft) => draft.dedupeKey)).toEqual([`${SID}:turn:1`]);
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
      ["session.done", `${SID}:turn:1`, "Build finished"],
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
    expect(drafts.map((draft) => draft.dedupeKey)).toEqual([`${SID}:turn:1`]);
  });

  test("rules armed after this turn, goal-scope rules and rules without done do not match", async () => {
    rules.rules.push(
      sessionRule("rule-future", { armedAtSeq: 1 }),
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
    expect(w.currentSeq(SID)).toBe(4);
  });

  test("child agent events are ignored", async () => {
    rules.rules.push(sessionRule("rule-a"));
    const w = watcher();
    await feed(w, [started(), { ...tool("Bash"), agentId: "child" }, done()]);
    expect(drafts).toEqual([]);
    await feed(w, [started(), tool("Bash"), { ...done(), agentId: "child" }]);
    expect(drafts).toEqual([]);
    expect(w.currentSeq(SID)).toBe(1);
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

  test("goal met without a goal id falls back to the seq", async () => {
    rules.rules.push(sessionRule("rule-goal", { scope: "goal" }));
    const w = watcher();
    await feed(w, [goal("met")]);
    expect(drafts[0]!.dedupeKey).toBe(`${SID}:goal:0`);
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
        dedupeKey: `${SID}:goal-pause:0`,
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
    await feed(w, [goal("not_met", { revision: 3, waitingForUser: "Which database?" })]);
    expect(drafts).toEqual([
      {
        kind: "session.blocked",
        priority: "P0",
        dedupeKey: `${SID}:goal-pause:3`,
        sessionId: SID,
        ruleIds: ["rule-a"],
        facts: { title: "修复登录", question: "Which database?" },
      },
    ]);
  });

  test("a bare waitingForUser flag also counts as blocked", async () => {
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
    await feed(w, [goal("exhausted", { gaps: "ran out" })]);
    expect(drafts.map((draft) => [draft.kind, draft.dedupeKey])).toEqual([
      ["session.blocked", `${SID}:goal-pause:0`],
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
        dedupeKey: `${SID}:failed:0`,
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
      ["session.failed", `${SID}:failed:0`, "provider down"],
    ]);
  });

  test("rules without failed do not match", async () => {
    rules.rules.push(sessionRule("rule-a", { events: ["done"] }));
    const w = watcher();
    await feed(w, [{ type: "error", error: "boom" }]);
    expect(drafts).toEqual([]);
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
});

describe("pending decisions", () => {
  test("pending-upsert emits a P0 blocked draft keyed by request id", async () => {
    rules.rules.push(sessionRule("rule-a"));
    const w = watcher();
    await w.observeProjection(
      pendingUpsert({
        ...pending(),
        options: [{ label: "Postgres", recommended: true }, { label: "SQLite" }],
      } as DesktopPendingDecision),
    );
    expect(drafts).toEqual([
      {
        kind: "session.blocked",
        priority: "P0",
        dedupeKey: `${SID}:req-1`,
        sessionId: SID,
        ruleIds: ["rule-a"],
        requestId: "req-1",
        expiresAt: NOW + 60_000,
        facts: {
          title: "修复登录",
          question: "需要用户回答",
          options: [{ label: "Postgres", recommended: true }, { label: "SQLite" }],
        },
      },
    ]);
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

describe("sequencing", () => {
  test("unseen sessions start at seq 0 and seq counts top-level turn completions", async () => {
    const w = watcher();
    expect(w.currentSeq("never")).toBe(0);
    await feed(w, [done(), done({ reason: "aborted_streaming" }), done()], "s-2");
    expect(w.currentSeq("s-2")).toBe(3);
    expect(w.currentSeq(SID)).toBe(0);
  });

  test("events for one session are processed in order even when not awaited", async () => {
    rules.rules.push(sessionRule("rule-a"));
    const w = watcher();
    await Promise.all([
      w.observe(SID, started()),
      w.observe(SID, tool("Bash")),
      w.observe(SID, done()),
    ]);
    expect(drafts.map((draft) => draft.dedupeKey)).toEqual([`${SID}:turn:0`]);
  });

  test("malformed events are ignored", async () => {
    const w = watcher();
    for (const event of [null, 3, "x", [], {}, { type: 5 }]) await w.observe(SID, event);
    expect(w.currentSeq(SID)).toBe(0);
  });
});
