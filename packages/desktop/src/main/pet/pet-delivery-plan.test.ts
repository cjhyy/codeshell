import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationSessionRoute, PetLongTask } from "@cjhyy/code-shell-pet";
import type { NoticeChannel, NoticeEvent } from "@cjhyy/code-shell-pet/protocol";
import {
  buildDeliveryPlan,
  createPetDeliveryResolver,
  mergeRuleAttributes,
  outcomeReporter,
  type DeliveryPlanEntry,
  type DeliveryPlanSources,
} from "./pet-delivery-plan.js";
import { PetRuleStore, type NoticeRule } from "./pet-rule-store.js";

const SID = "s-work";
const NOW = 1_700_000_000_000;

const LARK_CHAT = {
  kind: "im-gateway" as const,
  channel: "lark",
  target: "chat-9",
  senderId: "owner-9",
  isDirectMessage: true,
};

function rule(
  id: string,
  overrides: {
    events?: NoticeEvent[];
    scope?: "turn" | "goal";
    armedAt?: number;
    channel?: NoticeChannel;
    target?: NoticeRule["target"];
    origin?: NoticeRule["origin"];
    attention?: NoticeRule["attention"];
  } = {},
): NoticeRule {
  return {
    id,
    version: 1,
    origin: overrides.origin ?? "user",
    createdBy: overrides.origin === "delegation" ? "delegation" : "notify-me",
    when: {
      kind: "session",
      sessionId: SID,
      runtime: "native",
      events: overrides.events ?? ["done", "failed", "blocked"],
      scope: overrides.scope ?? "turn",
      armedAt: overrides.armedAt ?? NOW - 1_000,
    },
    then: { mode: "notify" },
    attention: overrides.attention ?? "always",
    channel: overrides.channel ?? "auto",
    target: overrides.target ?? { kind: "owner" },
    state: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function systemRule(channel: NoticeChannel = "auto"): NoticeRule {
  return {
    id: "all-sessions",
    version: 1,
    origin: "system",
    createdBy: "system",
    when: { kind: "all-sessions", events: ["done", "failed", "blocked"], onlyWhenAway: true },
    then: { mode: "notify" },
    attention: "always",
    channel,
    target: { kind: "owner" },
    state: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function task(overrides: Partial<PetLongTask> = {}): PetLongTask {
  return {
    id: "task-1",
    sessionId: SID,
    objective: "修复登录问题",
    status: "running",
    attempt: 1,
    runId: "run-1",
    ...overrides,
  } as PetLongTask;
}

function bound(overrides: Partial<ConversationSessionRoute> = {}): ConversationSessionRoute {
  return {
    schemaVersion: 1,
    id: "route-1",
    routeKey: "im:wechat\u0000chat-1\u0000owner-1",
    channel: "wechat",
    target: "chat-1",
    senderId: "owner-1",
    sessionId: SID,
    sessionTitle: "修登录",
    mode: "bound",
    origin: "enter",
    status: "active",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as ConversationSessionRoute;
}

const BOUND_TARGET: NoticeRule["target"] = {
  kind: "route",
  route: {
    kind: "im-gateway",
    channel: "wechat",
    target: "chat-1",
    senderId: "owner-1",
    isDirectMessage: true,
  },
};

/** One row per message somebody receives: [who writes it, where, channel, rules, reply]. */
function rows(entries: DeliveryPlanEntry[]) {
  return entries.map((entry) => [
    entry.composeBy,
    entry.replyRoute
      ? `${entry.replyRoute.channel}:${entry.replyRoute.target}`
      : entry.target.kind === "route"
        ? `${entry.target.route.channel}:${entry.target.route.target}`
        : "owner",
    entry.channel,
    entry.ruleIds,
    entry.reply,
  ]);
}

interface Scenario {
  name: string;
  event?: NoticeEvent;
  rules?: NoticeRule[];
  task?: PetLongTask;
  replyRoutes?: ConversationSessionRoute[];
  delegatedFromDesktop?: "auto" | "desktop";
  rows: ReturnType<typeof rows>;
  reporter: ReturnType<typeof outcomeReporter>;
  requiresAway?: boolean[];
}

const scenarios: Scenario[] = [
  {
    name: "a task delegated from an IM chat: Mimi's closure answers that chat",
    task: task({ completionTarget: LARK_CHAT }),
    rules: [
      rule("delegation", {
        origin: "delegation",
        channel: "lark",
        target: { kind: "route", route: LARK_CHAT },
      }),
    ],
    rows: [["mimi-closure", "lark:chat-9", "lark", ["delegation"], true]],
    reporter: "closure",
  },
  {
    name: "a task delegated from the desktop, only its own delegation rule",
    task: task(),
    rules: [rule("delegation", { origin: "delegation" })],
    rows: [["mimi-closure", "owner", "auto", ["delegation"], false]],
    reporter: "closure",
  },
  {
    name: "a task delegated from the desktop with no rule left: the settings decide the channel",
    task: task(),
    delegatedFromDesktop: "desktop",
    rows: [["mimi-closure", "owner", "desktop", [], false]],
    reporter: "closure",
  },
  {
    name: "a task delegated from the desktop whose owner asked for WeChat",
    task: task(),
    rules: [rule("owner", { channel: "wechat" })],
    delegatedFromDesktop: "desktop",
    rows: [["mimi-closure", "owner", "wechat", ["owner"], false]],
    reporter: "closure",
  },
  {
    name: "a delegation rule the owner took over is still the closure's one entry",
    task: task({ completionTarget: LARK_CHAT }),
    rules: [rule("taken-over", { origin: "user", target: { kind: "route", route: LARK_CHAT } })],
    rows: [["mimi-closure", "lark:chat-9", "lark", ["taken-over"], true]],
    reporter: "closure",
  },
  {
    name: "a delegated task in a bound Session: the closure and the Session's reply both go out",
    task: task(),
    rules: [rule("delegation", { origin: "delegation" })],
    replyRoutes: [bound()],
    rows: [
      ["mimi-closure", "owner", "auto", ["delegation"], false],
      ["session-reply", "wechat:chat-1", "wechat", [], false],
    ],
    reporter: "closure",
  },
  {
    name: "a bound Session with a bell set in that chat: the reply is the delivery",
    rules: [rule("bell", { target: BOUND_TARGET })],
    replyRoutes: [bound()],
    rows: [["session-reply", "wechat:chat-1", "auto", ["bell"], false]],
    reporter: "rules",
  },
  {
    name: "a bound Session with an owner bell on auto: merged into the reply",
    rules: [rule("bell")],
    replyRoutes: [bound()],
    rows: [["session-reply", "wechat:chat-1", "auto", ["bell"], false]],
    reporter: "rules",
  },
  {
    name: "a bound Session with an owner rule naming the bound chat's channel: merged",
    rules: [rule("notify-me", { channel: "wechat" })],
    replyRoutes: [bound()],
    rows: [["session-reply", "wechat:chat-1", "wechat", ["notify-me"], false]],
    reporter: "rules",
  },
  {
    name: "a bound Session with an owner rule naming another channel: a message of its own",
    rules: [rule("notify-me", { channel: "lark" })],
    replyRoutes: [bound()],
    rows: [
      ["template", "owner", "lark", ["notify-me"], false],
      ["session-reply", "wechat:chat-1", "wechat", [], false],
    ],
    reporter: "rules",
  },
  {
    name: "a bound Session with a desktop-only owner rule: not an IM matter",
    rules: [rule("notify-me", { channel: "desktop" })],
    replyRoutes: [bound()],
    rows: [
      ["template", "owner", "desktop", ["notify-me"], false],
      ["session-reply", "wechat:chat-1", "wechat", [], false],
    ],
    reporter: "rules",
  },
  {
    name: "a rule for another conversation than the bound one keeps its own message",
    rules: [rule("lark", { target: { kind: "route", route: LARK_CHAT } })],
    replyRoutes: [bound()],
    rows: [
      ["template", "lark:chat-9", "auto", ["lark"], false],
      ["session-reply", "wechat:chat-1", "wechat", [], false],
    ],
    reporter: "rules",
  },
  {
    name: "a conversation the Session left still receives its replies",
    rules: [rule("bell", { target: BOUND_TARGET })],
    replyRoutes: [bound({ mode: "notify" })],
    rows: [["session-reply", "wechat:chat-1", "auto", ["bell"], false]],
    reporter: "rules",
  },
  {
    name: "a bound Session nobody set a rule on: only the bridge has something to send",
    replyRoutes: [bound()],
    rows: [["session-reply", "wechat:chat-1", "wechat", [], false]],
    reporter: "none",
  },
  {
    name: "a NotifyMe rule alone",
    rules: [rule("notify-me", { channel: "wechat" })],
    rows: [["template", "owner", "wechat", ["notify-me"], false]],
    reporter: "rules",
  },
  {
    name: "the all-sessions system rule alone: only while the owner is away",
    rules: [systemRule()],
    rows: [["template", "owner", "auto", ["all-sessions"], false]],
    reporter: "rules",
    requiresAway: [true],
  },
  {
    name: "the system rule beside a Session rule is the same declaration, not a second message",
    rules: [rule("notify-me", { target: { kind: "route", route: LARK_CHAT } }), systemRule()],
    rows: [["template", "lark:chat-9", "auto", ["notify-me", "all-sessions"], false]],
    reporter: "rules",
    requiresAway: [false],
  },
  {
    name: "the system rule in a bound Session: the reply serves it",
    rules: [systemRule()],
    replyRoutes: [bound()],
    rows: [["session-reply", "wechat:chat-1", "auto", ["all-sessions"], false]],
    reporter: "rules",
    requiresAway: [true],
  },
  {
    name: "nobody asked",
    rows: [],
    reporter: "none",
  },
  {
    name: "blocked in an IM-started task: the decision is answered in that chat",
    event: "blocked",
    task: task({ completionTarget: LARK_CHAT }),
    rules: [
      rule("delegation", { origin: "delegation", target: { kind: "route", route: LARK_CHAT } }),
    ],
    replyRoutes: [bound()],
    rows: [["template", "lark:chat-9", "lark", ["delegation"], true]],
    reporter: "rules",
  },
  {
    name: "blocked in a desktop-started task: its rules decide",
    event: "blocked",
    task: task(),
    rules: [rule("delegation", { origin: "delegation" })],
    rows: [["template", "owner", "auto", ["delegation"], false]],
    reporter: "rules",
  },
  {
    name: "blocked is never served by a Session reply",
    event: "blocked",
    rules: [rule("bell", { target: BOUND_TARGET })],
    replyRoutes: [bound()],
    rows: [["template", "wechat:chat-1", "auto", ["bell"], false]],
    reporter: "rules",
  },
];

describe("buildDeliveryPlan", () => {
  test.each(scenarios)("$name", (scenario) => {
    const entries = buildDeliveryPlan({
      event: scenario.event ?? "done",
      rules: scenario.rules ?? [],
      ...(scenario.task ? { task: scenario.task } : {}),
      replyRoutes: scenario.replyRoutes ?? [],
      delegatedFromDesktop: scenario.delegatedFromDesktop ?? "auto",
    });
    expect(rows(entries)).toEqual(scenario.rows);
    expect(outcomeReporter({ entries, rules: scenario.rules ?? [] })).toBe(scenario.reporter);
    if (scenario.requiresAway)
      expect(entries.map((entry) => entry.requiresAway)).toEqual(scenario.requiresAway);
    // A closure is always delivered at once and to everyone it names.
    for (const entry of entries.filter((item) => item.composeBy === "mimi-closure"))
      expect(entry).toMatchObject({ attention: "always", requiresAway: false });
  });

  test("the strongest attention and the most specific channel win", () => {
    const [entry] = buildDeliveryPlan({
      event: "done",
      rules: [
        rule("digest", { attention: "digest" }),
        rule("named", { attention: "important", channel: "lark" }),
        systemRule("desktop"),
      ],
      replyRoutes: [],
      delegatedFromDesktop: "auto",
    });
    expect(entry).toMatchObject({ attention: "always", channel: "lark", key: "owner" });
  });

  test("entries are keyed by the rule store's conversation identity", () => {
    const entries = buildDeliveryPlan({
      event: "done",
      rules: [rule("lark", { target: { kind: "route", route: LARK_CHAT } })],
      replyRoutes: [bound()],
      delegatedFromDesktop: "auto",
    });
    expect(entries.map((entry) => entry.key)).toEqual([
      "im:lark\u0000chat-9\u0000owner-9",
      "im:wechat\u0000chat-1\u0000owner-1",
    ]);
  });
});

describe("mergeRuleAttributes", () => {
  const base = {
    attention: "important",
    channel: "auto",
    target: { kind: "owner" },
  } as unknown as NoticeRule;
  test("strongest attention, named IM over auto, route over owner", () => {
    const route = {
      kind: "route",
      route: { kind: "im-gateway", channel: "wechat", target: "chat-1" },
    } as const;
    expect(
      mergeRuleAttributes([
        base,
        { ...base, attention: "always", channel: "lark" },
        { ...base, channel: "desktop", target: route },
      ]),
    ).toEqual({ attention: "always", channel: "lark", target: route });
    expect(mergeRuleAttributes([{ ...base, channel: "desktop" }]).channel).toBe("desktop");
    expect(mergeRuleAttributes([{ ...base, channel: "desktop" }, base]).channel).toBe("auto");
  });
});

describe("createPetDeliveryResolver", () => {
  let rules: NoticeRule[];
  let tasks: PetLongTask[];
  let routes: ConversationSessionRoute[];
  let routesFail: boolean;
  let logs: string[];

  const resolver = (overrides: Partial<DeliveryPlanSources> = {}) =>
    createPetDeliveryResolver({
      rules: { activeForSession: () => rules },
      longTasks: {
        activeForSession: (sessionId) =>
          tasks.find(
            (item) =>
              item.sessionId === sessionId &&
              !["completed", "failed", "cancelled"].includes(item.status),
          ),
        getSnapshot: () => ({ tasks }),
      },
      replyRoutes: async () => {
        if (routesFail) throw new Error("routes unreadable");
        return routes;
      },
      delegatedFromDesktop: () => "auto",
      log: (event) => logs.push(event),
      ...overrides,
    });

  beforeEach(() => {
    rules = [];
    tasks = [];
    routes = [];
    routesFail = false;
    logs = [];
  });

  test("goal-scope and turn-scope outcomes satisfy their own rules only", async () => {
    rules = [rule("turn"), rule("goal", { scope: "goal" }), systemRule()];
    const plan = (scope: "turn" | "goal", includeSystem = true) =>
      resolver()
        .plan({ sessionId: SID, event: "done", scope, at: NOW, includeSystem })
        .then((result) => result.entries.flatMap((entry) => entry.ruleIds));
    expect(await plan("turn")).toEqual(["turn", "all-sessions"]);
    expect(await plan("goal")).toEqual(["goal", "all-sessions"]);
    // The turn that closes a run whose Goal already told the system rule.
    expect(await plan("turn", false)).toEqual(["turn"]);
    // failed and blocked are not scoped.
    const failed = await resolver().plan({ sessionId: SID, event: "failed", at: NOW });
    expect(failed.rules.map((item) => item.id)).toEqual(["turn", "goal", "all-sessions"]);
  });

  test("a rule only hears outcomes from after it was armed, and only its events", async () => {
    rules = [
      rule("late", { armedAt: NOW + 1 }),
      rule("done-only", { events: ["done"] }),
      rule("early"),
    ];
    const ids = async (event: NoticeEvent, at?: number) =>
      (
        await resolver().plan({ sessionId: SID, event, ...(at !== undefined ? { at } : {}) })
      ).rules.map((item) => item.id);
    expect(await ids("done", NOW)).toEqual(["done-only", "early"]);
    expect(await ids("failed", NOW)).toEqual(["early"]);
    // A closure (no outcome time) takes every active rule for the event.
    expect(await ids("done")).toEqual(["late", "done-only", "early"]);
  });

  test("a long task owns its Session while active and the run it closed, no later run", async () => {
    rules = [rule("delegation", { origin: "delegation" })];
    const reporter = async (runKey: string) =>
      outcomeReporter(await resolver().plan({ sessionId: SID, event: "done", at: NOW, runKey }));
    tasks = [task({ status: "running", runId: "run-1" })];
    expect(await reporter("run-1")).toBe("closure");
    expect(await reporter("run-2")).toBe("closure");
    tasks = [task({ status: "completed", runId: "run-1" })];
    expect(await reporter("run-1")).toBe("closure");
    expect(await reporter("run-2")).toBe("rules");
    tasks = [task({ status: "completed", runId: "run-1", sessionId: "s-other" })];
    expect(await reporter("run-1")).toBe("rules");
  });

  test("a blocked outcome is the rules' to report even while a task owns the run", async () => {
    rules = [rule("delegation", { origin: "delegation" })];
    tasks = [task({ completionTarget: LARK_CHAT })];
    const plan = await resolver().plan({ sessionId: SID, event: "blocked", at: NOW });
    expect(rows(plan.entries)).toEqual([["template", "owner", "auto", ["delegation"], false]]);
    // A pending decision names its task: the IM chat that started it answers.
    const prompt = resolver().planBlocked({ sessionId: SID, task: tasks[0]! });
    expect(rows(prompt.entries)).toEqual([
      ["template", "lark:chat-9", "lark", ["delegation"], true],
    ]);
    // A Session rules may not watch still prompts the chat that started its task.
    const unwatched = resolver().planBlocked({ sessionId: SID, task: tasks[0]!, useRules: false });
    expect(rows(unwatched.entries)).toEqual([["template", "lark:chat-9", "lark", [], true]]);
    expect(resolver().planBlocked({ sessionId: SID, useRules: false }).entries).toEqual([]);
  });

  test("routes that cannot be read: the plan sends the notice, the bridge retries", async () => {
    rules = [rule("bell")];
    routes = [bound()];
    routesFail = true;
    const plan = await resolver().plan({ sessionId: SID, event: "done", at: NOW });
    expect(rows(plan.entries)).toEqual([["template", "owner", "auto", ["bell"], false]]);
    expect(logs).toEqual(["pet.notice.route_lookup_failed"]);
    await expect(resolver().replyRoutes(SID)).rejects.toThrow("routes unreadable");
    routesFail = false;
    expect((await resolver().replyRoutes(SID)).map((route) => route.id)).toEqual(["route-1"]);
  });

  test("a new rule's target: the bound chat, else the active task's IM origin, else the owner", async () => {
    expect(await resolver().ruleTarget(SID)).toEqual({ kind: "owner" });
    tasks = [task({ completionTarget: LARK_CHAT })];
    expect(await resolver().ruleTarget(SID)).toEqual({ kind: "route", route: LARK_CHAT });
    // A conversation that left (or was suspended) is not where a new rule points.
    routes = [bound({ mode: "notify" }), bound({ id: "route-2", status: "suspended" })];
    expect(await resolver().ruleTarget(SID)).toEqual({ kind: "route", route: LARK_CHAT });
    routes = [bound()];
    expect(await resolver().ruleTarget(SID)).toEqual(BOUND_TARGET);
  });

  test("a task's origin is where its delegation rule and its closure both point", () => {
    expect(resolver().taskOrigin(task({ completionTarget: LARK_CHAT }))).toEqual({
      target: { kind: "route", route: LARK_CHAT },
      channel: "lark",
    });
    expect(resolver({ delegatedFromDesktop: () => "desktop" }).taskOrigin(task())).toEqual({
      target: { kind: "owner" },
      channel: "desktop",
    });
  });
});

describe("with the real rule store", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pet-delivery-plan-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("the owner takes over a delegation rule: still one entry, now on the owner's terms", async () => {
    const store = new PetRuleStore({ path: join(dir, "rules.json"), now: () => NOW });
    await store.load();
    const delegated = task();
    const resolver = createPetDeliveryResolver({
      rules: store,
      longTasks: { activeForSession: () => delegated, getSnapshot: () => ({ tasks: [delegated] }) },
      replyRoutes: async () => [],
      delegatedFromDesktop: () => "auto",
    });
    const armed = await store.upsertSessionRule({
      sessionId: SID,
      createdBy: "delegation",
      events: ["done", "failed", "blocked"],
      scope: "turn",
      attention: "always",
      ...resolver.taskOrigin(delegated),
      origin: "delegation",
      armedAt: NOW,
    });
    const closure = () => resolver.plan({ sessionId: SID, event: "done", task: delegated });
    expect(rows((await closure()).entries)).toEqual([
      ["mimi-closure", "owner", "auto", [armed.id], false],
    ]);
    // The owner says "tell me on WeChat when it is done" in that Session.
    const taken = await store.upsertSessionRule({
      sessionId: SID,
      createdBy: "notify-me",
      events: ["done"],
      scope: "turn",
      channel: "wechat",
      attention: "always",
      target: await resolver.ruleTarget(SID),
      origin: "user",
      armedAt: NOW,
    });
    expect(taken.id).toBe(armed.id);
    expect(rows((await closure()).entries)).toEqual([
      ["mimi-closure", "owner", "wechat", [armed.id], false],
    ]);
    // The task's failure is not what the owner's rule asked about.
    expect(
      rows((await resolver.plan({ sessionId: SID, event: "failed", task: delegated })).entries),
    ).toEqual([["mimi-closure", "owner", "auto", [], false]]);
  });
});
