import { describe, expect, test } from "bun:test";
import type { PetLongTask } from "@cjhyy/code-shell-pet";
import type { FollowUpRule } from "./pet-follow-up-rules.js";
import type { NoticeRecord } from "./pet-notice-ledger.js";
import {
  collectBrief,
  parseBriefWriteUp,
  renderBrief,
  templateBrief,
  writeBrief,
  type BriefSources,
  type BriefWindow,
} from "./pet-proactive-brief.js";
import type { DesktopPetSession } from "./pet-state-aggregator.js";

const HOUR = 3_600_000;
const TODAY = Date.UTC(2023, 10, 15);
const NOW = TODAY + 9 * HOUR;
const WINDOW: BriefWindow = {
  since: TODAY - 24 * HOUR,
  now: NOW,
  todayStart: TODAY,
  tomorrowStart: TODAY + 24 * HOUR,
  dayAfterStart: TODAY + 48 * HOUR,
};

function task(overrides: Partial<PetLongTask>): PetLongTask {
  return {
    id: "t",
    sessionId: "s",
    objective: "任务",
    status: "completed",
    artifacts: [],
    events: [],
    createdAt: TODAY - 30 * HOUR,
    updatedAt: NOW,
    ...overrides,
  } as PetLongTask;
}

function followUp(id: string, occurrence: number, title: string): FollowUpRule {
  return {
    id,
    version: 1,
    origin: "user",
    createdBy: "follow-up",
    when: { kind: "schedule", at: occurrence, timezone: "UTC", missedPolicy: "fire-once" },
    then: { mode: "remind", title, text: `${title}的提醒` },
    wake: { occurrence, status: "scheduled" },
    attention: "always",
    channel: "auto",
    target: { kind: "owner" },
    state: "active",
    createdAt: 0,
    updatedAt: 0,
  } as FollowUpRule;
}

function empty(): BriefSources {
  return { tasks: [], sessions: [], pending: [], followUps: [], items: [] };
}

describe("collectBrief", () => {
  test("nothing to say: no brief", () => {
    expect(collectBrief("morning", WINDOW, empty())).toBeUndefined();
    // Finished before the last brief: not news.
    expect(
      collectBrief("morning", WINDOW, {
        ...empty(),
        tasks: [task({ completedAt: WINDOW.since - 1 })],
      }),
    ).toBeUndefined();
  });

  test("morning: finished since the last brief, still running, decisions, today's follow-ups, open items", () => {
    const sources: BriefSources = {
      tasks: [
        task({
          id: "a",
          sessionId: "sa",
          objective: "写周报",
          completedAt: NOW - HOUR,
          resultSummary: "发出去了",
        }),
        task({
          id: "b",
          sessionId: "sb",
          objective: "跑测试",
          status: "failed",
          completedAt: NOW - 2 * HOUR,
          lastError: "超时",
        }),
        task({ id: "c", sessionId: "sc", objective: "迁移数据", status: "running" }),
        task({
          id: "d",
          sessionId: "sd",
          objective: "取消的",
          status: "cancelled",
          completedAt: NOW - HOUR,
        }),
      ],
      sessions: [
        { agentSessionId: "sc", title: "迁移数据会话", runState: "running" } as DesktopPetSession,
        {
          agentSessionId: "se",
          title: "调研",
          runState: "running",
          summary: "看文档",
        } as DesktopPetSession,
        { agentSessionId: "sf", title: "空闲", runState: "idle" } as DesktopPetSession,
      ],
      pending: [
        {
          agentSessionId: "sg",
          requestId: "r",
          title: "删库审批",
          kind: "approval",
          status: "pending",
          createdAt: NOW - HOUR,
        } as never,
      ],
      followUps: [
        followUp("rule-1", NOW + HOUR, "交材料"),
        followUp("rule-2", TODAY + 30 * HOUR, "明天的"),
        followUp("rule-3", NOW - HOUR, "已过点"),
      ],
      items: [
        {
          id: "n1",
          kind: "session.failed",
          createdAt: NOW - HOUR,
          sessionId: "sh",
          facts: { title: "构建", target: { kind: "owner" } },
          actions: {
            code: "AAAAAAAAAAAA",
            family: "failure",
            sessionId: "sh",
            runtime: "native",
            expiresAt: NOW + HOUR,
          },
        } as unknown as NoticeRecord,
      ],
    };
    const facts = collectBrief("morning", WINDOW, sources);
    expect(facts?.records.map((record) => [record.ref, record.type, record.title])).toEqual([
      ["r1", "decision", "删库审批"],
      ["r2", "item", "构建"],
      ["r3", "failed", "跑测试"],
      ["r4", "done", "写周报"],
      ["r5", "running", "迁移数据"],
      ["r6", "running", "调研"],
      ["r7", "follow-up", "交材料"],
    ]);
    expect(facts?.records[2]?.detail).toBe("超时");
    // The host's status labels: an open failure item is "not done", not "failed".
    expect(facts?.records.map((record) => record.status)).toEqual([
      "【等你决定】",
      "【没做完】",
      "【失败】",
      "【完成】",
      "【进行中】",
      "【进行中】",
      "【今天到期】",
    ]);
  });

  test("evening: what was dispatched today however it stands, what hangs, tomorrow's follow-ups", () => {
    const sources: BriefSources = {
      ...empty(),
      tasks: [
        task({
          id: "a",
          objective: "今天派的",
          createdAt: TODAY + HOUR,
          status: "running",
          sessionId: "sa",
        }),
        task({
          id: "b",
          objective: "今天做完",
          createdAt: TODAY + HOUR,
          completedAt: NOW - HOUR,
          sessionId: "sb",
        }),
        task({
          id: "c",
          objective: "昨天派的还在等",
          status: "waiting",
          waitingFor: "等审批",
          sessionId: "sc",
        }),
        task({ id: "d", objective: "昨天做完", completedAt: TODAY - HOUR, sessionId: "sd" }),
      ],
      followUps: [
        followUp("rule-1", NOW + HOUR, "今天的"),
        followUp("rule-2", TODAY + 33 * HOUR, "明天的"),
      ],
    };
    const facts = collectBrief("evening", { ...WINDOW, now: TODAY + 18 * HOUR }, sources);
    expect(facts?.records.map((record) => [record.type, record.title])).toEqual([
      ["done", "今天做完"],
      ["waiting", "昨天派的还在等"],
      ["running", "今天派的"],
      ["follow-up", "明天的"],
    ]);
    expect(facts?.records.at(-1)?.status).toBe("【明天到期】");
  });
});

describe("the write-up", () => {
  const facts = {
    kind: "morning" as const,
    records: [
      {
        ref: "r1",
        type: "decision" as const,
        status: "【等你决定】",
        title: "删库审批",
        at: NOW - HOUR,
      },
      { ref: "r2", type: "failed" as const, status: "【失败】", title: "跑测试", detail: "超时" },
      { ref: "r3", type: "done" as const, status: "【完成】", title: "写周报" },
    ],
  };
  const morning = { now: NOW, offsetMin: () => 0 };

  test("every line names provided records, each at most once", () => {
    const valid = JSON.stringify({
      opening: "早！",
      items: [
        { refs: ["r1"], text: "删库那个等你审批" },
        { refs: ["r3"], text: "周报" },
      ],
      closing: "今天先做哪个？",
    });
    expect(parseBriefWriteUp(valid, facts)).toEqual({
      opening: "早！",
      items: [
        { refs: ["r1"], text: "删库那个等你审批" },
        { refs: ["r3"], text: "周报" },
      ],
      closing: "今天先做哪个？",
    });
    const bad = (value: unknown) => parseBriefWriteUp(JSON.stringify(value), facts);
    expect(bad({ items: [{ refs: ["r9"], text: "编出来的" }] })).toBeUndefined();
    expect(bad({ items: [{ refs: [], text: "没有记录" }] })).toBeUndefined();
    expect(
      bad({
        items: [
          { refs: ["r1"], text: "a" },
          { refs: ["r1"], text: "b" },
        ],
      }),
    ).toBeUndefined();
    expect(bad({ items: [{ refs: ["r1"], text: "两行\n文字" }] })).toBeUndefined();
    expect(bad({ items: [{ refs: ["r1"], text: "x" }], extra: 1 })).toBeUndefined();
    expect(bad({ items: [] })).toBeUndefined();
    expect(parseBriefWriteUp("就是一段话", facts)).toBeUndefined();
  });

  test("the host leads each line with the record's status and adds what must not be left out", () => {
    const text = renderBrief(
      facts,
      // A write-up that calls the failure a success and skips the decision.
      { items: [{ refs: ["r2"], text: "测试搞定了" }] },
      morning,
    );
    expect(text).toBe(
      ["早上好，今天的情况：", "- 【失败】测试搞定了", "- 【等你决定】「删库审批」"].join("\n"),
    );
  });

  test("one line may only group records with the same status", () => {
    const mixed = {
      kind: "morning" as const,
      records: [
        { ref: "r1", type: "done" as const, status: "【完成】", title: "登录" },
        { ref: "r2", type: "cancelled" as const, status: "【取消】", title: "支付" },
        { ref: "r3", type: "decision" as const, status: "【等你决定】", title: "部署" },
        { ref: "r4", type: "failed" as const, status: "【失败】", title: "迁移" },
        { ref: "r5", type: "done" as const, status: "【完成】", title: "周报" },
      ],
    };
    const read = (items: unknown) => parseBriefWriteUp(JSON.stringify({ items }), mixed);
    // A cancelled record would read as done; a failure would vanish under the decision.
    expect(read([{ refs: ["r1", "r2"], text: "登录和支付都处理好了" }])).toBeUndefined();
    expect(read([{ refs: ["r3", "r4"], text: "部署要你拍板" }])).toBeUndefined();
    expect(read([{ refs: ["r1", "r5"], text: "登录和周报" }])).toEqual({
      items: [{ refs: ["r1", "r5"], text: "登录和周报" }],
    });
  });

  test("a mixed-status answer is invalid: the next model, then the template", async () => {
    const merged = async () =>
      JSON.stringify({ items: [{ refs: ["r1", "r2"], text: "删库和测试都处理了" }] });
    expect(await writeBrief(facts, [merged], morning)).toEqual({
      text: templateBrief(facts, morning),
      by: "template",
    });
  });

  test("the model's write-up when valid; otherwise the next model; none: the template", async () => {
    const calls: string[] = [];
    const invalid = async () => {
      calls.push("aux");
      return JSON.stringify({ items: [{ refs: ["r9"], text: "不存在" }] });
    };
    const main = async ({ user }: { user: string }) => {
      calls.push("main");
      const payload = JSON.parse(user);
      // The owner's own clock, with its offset.
      expect(payload.now).toBe(new Date(NOW).toISOString().slice(0, 19) + "+00:00");
      expect(payload.records[0]).toMatchObject({
        status: "【等你决定】",
        at: "2023-11-15T08:00:00+00:00",
      });
      return '```json\n{"items":[{"refs":["r1"],"text":"删库要你批"},{"refs":["r2"],"text":"测试超时"},{"refs":["r3"],"text":"周报好了"}]}\n```';
    };
    expect(await writeBrief(facts, [invalid, main], morning)).toEqual({
      text: "早上好，今天的情况：\n- 【等你决定】删库要你批\n- 【失败】测试超时\n- 【完成】周报好了",
      by: "model",
    });
    expect(calls).toEqual(["aux", "main"]);
    const down = async () => {
      throw new Error("no model");
    };
    expect(await writeBrief(facts, [down], morning)).toEqual({
      text: templateBrief(facts, morning),
      by: "template",
    });
    expect(templateBrief(facts, morning)).toBe(
      "早上好，今天的情况：\n- 【等你决定】「删库审批」\n- 【失败】「跑测试」：超时\n- 【完成】「写周报」",
    );
  });

  test("a morning brief caught up in the afternoon does not say good morning", () => {
    expect(templateBrief(facts, { now: TODAY + 15 * HOUR, offsetMin: () => 0 })).toStartWith(
      "今天到现在的情况：",
    );
  });
});
