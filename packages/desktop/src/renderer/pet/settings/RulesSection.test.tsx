import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import type { Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../../test-utils/renderHook";
import type {
  PetNoticeRuleSummary,
  PetNoticeRuleUpdate,
  PetNoticeRuleUpdateResult,
  PetNoticesState,
} from "../../../shared/pet-notices";
import type { ConfirmDialogOptions } from "../../ui/dialogState";

ensureMiniDom();
const { createRoot } = await import("react-dom/client");
const { RulesSection } = await import("./RulesSection");
const { ruleTime } = await import("./noticeRuleText");

function reactPropsOf(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
}

function find(node: any, attribute: string, value?: string): any[] {
  const own = node.getAttribute?.(attribute);
  return [
    ...(own !== null && own !== undefined && (value === undefined || own === value) ? [node] : []),
    ...(node.childNodes ?? []).flatMap((child: any) => find(child, attribute, value)),
  ];
}

/** React writes a lone string child as `textContent`, without a text node. */
function text(node: any): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  const children = node.childNodes ?? [];
  return children.length > 0 ? children.map(text).join("") : (node.textContent ?? "");
}

const NEXT = Date.UTC(2026, 10, 12, 1, 0);
const LAST = Date.UTC(2026, 10, 11, 1, 0);

const SYSTEM: PetNoticeRuleSummary[] = [
  {
    id: "all-sessions",
    version: 0,
    kind: "all-sessions",
    state: "paused",
    source: "system",
    events: ["done", "failed", "blocked"],
    target: { kind: "auto", label: "微信", ready: "ready" },
    actions: ["resume"],
    updatedAt: 0,
  },
  {
    id: "system-brief-morning",
    version: 3,
    kind: "system-brief",
    state: "active",
    source: "system",
    brief: "morning",
    dailyAt: "09:00",
    schedule: { cron: "0 9 * * *", timezone: "Asia/Shanghai", nextAt: NEXT },
    lastFiredAt: LAST,
    lastOutcome: "notified",
    target: { kind: "auto", label: "微信", ready: "ready" },
    actions: ["pause"],
    updatedAt: 5,
  },
  {
    id: "system-heartbeat",
    version: 0,
    kind: "system-heartbeat",
    state: "paused",
    source: "system",
    activeHours: { start: "09:00", end: "22:00" },
    target: { kind: "auto" },
    actions: ["resume"],
    updatedAt: 0,
  },
];

const SESSION: PetNoticeRuleSummary = {
  id: "rule-session",
  version: 2,
  kind: "session",
  state: "active",
  source: "watch",
  sessionId: "s-work",
  sessionTitle: "修登录",
  events: ["done", "blocked"],
  scope: "goal",
  target: { kind: "chat", label: "飞书", direct: false },
  actions: ["pause", "cancel"],
  updatedAt: 9,
};

const FOLLOW_UP: PetNoticeRuleSummary = {
  id: "rule-follow-up",
  version: 1,
  kind: "schedule",
  state: "paused",
  source: "follow-up",
  title: "看看 PR 有没有人回",
  followUp: "continue",
  sessionId: "s-pr",
  schedule: { cron: "0 9 * * 1-5", label: "工作日 09:00", timezone: "Asia/Shanghai" },
  target: { kind: "channel", label: "Telegram", ready: "unknown" },
  actions: ["resume", "cancel"],
  updatedAt: 8,
};

const ENDED: PetNoticeRuleSummary = {
  id: "rule-ended",
  version: 4,
  kind: "session",
  state: "spent",
  source: "owner",
  sessionId: "s-old",
  sessionTitle: "旧会话",
  events: ["done"],
  scope: "turn",
  lastFiredAt: LAST,
  target: { kind: "desktop" },
  actions: [],
  updatedAt: 3,
};

function noticesState(rules: PetNoticeRuleSummary[]): PetNoticesState {
  return {
    channels: [{ id: "wechat", label: "微信", ready: "ready" }],
    systemRule: { state: "paused", channel: "auto", events: ["done", "failed", "blocked"] },
    settings: {
      quietHours: { enabled: true, start: "23:00", end: "08:30" },
      maxPerHour: 6,
      maxP0PerHour: 12,
      mergeWindowSec: 600,
      presenceIdleSec: 120,
      delegatedFromDesktop: "auto",
    },
    proactive: {
      briefs: { morning: {}, evening: {} },
      heartbeat: {
        judgedToday: 3,
        saidToday: 1,
        judgeCap: 8,
        sayCap: 4,
        atJudgeCap: false,
        atSayCap: false,
      },
    },
    rules,
  };
}

describe("Mimi settings › 规则与跟进", () => {
  let root: Root | null = null;
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
  });

  async function mount(options: {
    rules: PetNoticeRuleSummary[];
    update?: (request: PetNoticeRuleUpdate) => Promise<PetNoticeRuleUpdateResult>;
    confirm?: (options: ConfirmDialogOptions) => Promise<boolean>;
  }) {
    const state = { current: noticesState(options.rules) };
    const calls: PetNoticeRuleUpdate[] = [];
    const opened: string[] = [];
    const navigations: string[] = [];
    let reads = 0;
    const api = {
      getNoticesState: async () => {
        reads += 1;
        return structuredClone(state.current);
      },
      onNoticesChanged: () => () => undefined,
      updateNoticeRule: async (request: PetNoticeRuleUpdate) => {
        calls.push(request);
        return options.update ? options.update(request) : ({ ok: true } as const);
      },
    };
    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <RulesSection
          api={api}
          confirm={options.confirm ?? (async () => true)}
          onOpenNotifications={() => navigations.push("notifications")}
          onOpenSession={(id) => opened.push(id)}
        />,
      );
      for (let index = 0; index < 4; index += 1) await flushMicrotasks();
    });
    return { container, calls, opened, navigations, state, reads: () => reads };
  }

  async function click(node: any) {
    await act(async () => {
      reactPropsOf(node).onClick();
      for (let index = 0; index < 4; index += 1) await flushMicrotasks();
    });
  }

  test("groups every trigger and shows its structured when, target, source and last fire", async () => {
    const { container } = await mount({ rules: [...SYSTEM, SESSION, FOLLOW_UP, ENDED] });
    const groups = find(container, "data-rules-group").map((node) =>
      node.getAttribute("data-rules-group"),
    );
    expect(groups).toEqual(["sessions", "followUps", "proactive", "ended"]);

    const [session] = find(container, "data-pet-rule", "rule-session");
    expect(text(session)).toContain("修登录");
    expect(text(session)).toContain("IM 里在看");
    expect(text(session)).toContain("完成、卡住时提醒、目标整体完成后");
    expect(text(session)).toContain("回到飞书群聊");

    const [followUp] = find(container, "data-pet-rule", "rule-follow-up");
    expect(text(followUp)).toContain("看看 PR 有没有人回");
    expect(text(followUp)).toContain("你让 Mimi 记的");
    expect(text(followUp)).toContain("已暂停");
    expect(text(followUp)).toContain("工作日 09:00、到点先续办会话，再告诉你结果");
    expect(text(followUp)).toContain("发到Telegram（未就绪）");
    // The raw cron is only a tooltip.
    const [when] = find(followUp, "data-rule-when");
    expect(when.getAttribute("title")).toBe("cron：0 9 * * 1-5（Asia/Shanghai）");
    expect(text(when)).not.toContain("0 9 * * 1-5");

    const [morning] = find(container, "data-pet-rule", "system-brief-morning");
    expect(text(morning)).toContain("晨报");
    expect(text(morning)).toContain("Mimi 自带");
    expect(text(morning)).toContain("每天 09:00");
    expect(text(find(morning, "data-rule-next")[0])).toContain(`下次 ${ruleTime(NEXT, "zh")}`);
    expect(text(find(morning, "data-rule-last")[0])).toBe(`上次 ${ruleTime(LAST, "zh")}：已提醒`);
    const [heartbeat] = find(container, "data-pet-rule", "system-heartbeat");
    expect(text(heartbeat)).toContain("09:00–22:00 每 30 分钟看一眼");
    expect(text(heartbeat)).toContain("今天判断 3/8 次，发了 1/4 条");
    expect(text(heartbeat)).toContain("在电脑前发桌面（没有可用的消息渠道）");

    // Ended rules stay folded until asked for.
    expect(find(container, "data-pet-rule", "rule-ended")).toHaveLength(0);
    const [toggle] = find(container, "data-rules-ended-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(text(toggle)).toContain("最近结束（1）");
    await click(toggle);
    const [ended] = find(container, "data-pet-rule", "rule-ended");
    expect(text(ended)).toContain("已提醒");
    expect(find(ended, "data-rule-action")).toHaveLength(0);
  });

  test("lists are labelled and each action button names its rule", async () => {
    const { container } = await mount({ rules: [...SYSTEM, SESSION] });
    const lists = find(container, "aria-labelledby");
    for (const list of lists) {
      const id = list.getAttribute("aria-labelledby");
      expect(find(container, "id", id)).toHaveLength(1);
    }
    expect(lists.length).toBeGreaterThanOrEqual(2);
    const [pause] = find(
      find(container, "data-pet-rule", "rule-session")[0],
      "data-rule-action",
      "pause",
    );
    expect(pause.getAttribute("aria-label")).toBe("暂停“修登录”");
    const [open] = find(container, "data-rule-open-session");
    expect(open.getAttribute("aria-label")).toBe("打开会话“修登录”");
  });

  test("pause and resume send the version the owner saw, then refresh", async () => {
    const view = await mount({ rules: [...SYSTEM, SESSION, FOLLOW_UP] });
    const before = view.reads();
    const [pause] = find(
      find(view.container, "data-pet-rule", "rule-session")[0],
      "data-rule-action",
      "pause",
    );
    await click(pause);
    const [resume] = find(
      find(view.container, "data-pet-rule", "system-brief-morning")[0],
      "data-rule-action",
    );
    expect(resume.getAttribute("data-rule-action")).toBe("pause");
    await click(resume);
    expect(view.calls).toEqual([
      { ruleId: "rule-session", expectedVersion: 2, action: "pause" },
      { ruleId: "system-brief-morning", expectedVersion: 3, action: "pause" },
    ]);
    expect(view.reads()).toBeGreaterThan(before);
  });

  test("delete asks first, and nothing changes when the owner backs out", async () => {
    const answers = [false, true];
    const asked: ConfirmDialogOptions[] = [];
    const view = await mount({
      rules: [...SYSTEM, FOLLOW_UP],
      confirm: async (options) => {
        asked.push(options);
        return answers.shift() ?? false;
      },
    });
    const [cancel] = find(view.container, "data-rule-action", "cancel");
    await click(cancel);
    expect(view.calls).toEqual([]);
    expect(asked[0]).toMatchObject({ destructive: true, confirmLabel: "删除" });
    expect(asked[0]?.message).toContain("看看 PR 有没有人回");
    await click(cancel);
    expect(view.calls).toEqual([
      { ruleId: "rule-follow-up", expectedVersion: 1, action: "cancel" },
    ]);
  });

  test("a version conflict or a failure is explained, not swallowed", async () => {
    const results: Array<() => Promise<PetNoticeRuleUpdateResult>> = [
      async () => ({ ok: false, reason: "version_conflict" }),
      async () => {
        throw new Error("rules.json is read-only");
      },
    ];
    const view = await mount({
      rules: [...SYSTEM, SESSION],
      update: () => results.shift()!(),
    });
    const action = () =>
      find(
        find(view.container, "data-pet-rule", "rule-session")[0],
        "data-rule-action",
        "pause",
      )[0];
    await click(action());
    expect(text(find(view.container, "data-rules-message", "info")[0])).toContain(
      "这条规则刚被改过，已刷新",
    );
    await click(action());
    const [failed] = find(view.container, "data-rules-message", "error");
    expect(failed.getAttribute("role")).toBe("alert");
    expect(text(failed)).toContain("没改成：rules.json is read-only");
  });

  test("jumps to the rule's Session and to 通知与主动", async () => {
    const view = await mount({ rules: [...SYSTEM, SESSION, FOLLOW_UP] });
    for (const node of find(view.container, "data-rule-open-session")) await click(node);
    expect(view.opened).toEqual(["s-work", "s-pr"]);
    await click(find(view.container, "data-pet-rules-open-notifications")[0]);
    expect(view.navigations).toEqual(["notifications"]);
  });

  test("with no Session rules or follow-ups it says how to make one, including asking Mimi", async () => {
    const { container } = await mount({ rules: SYSTEM });
    expect(text(find(container, "data-rules-empty")[0])).toContain("在会话顶栏点铃铛");
    expect(text(find(container, "data-rules-talk-hint")[0])).toBe(
      "也可以直接跟 Mimi 说：“把每天早上那个提醒停了”。",
    );
    // Mimi's own rules are still there to switch.
    expect(find(container, "data-rules-group", "proactive")).toHaveLength(1);
  });
});
