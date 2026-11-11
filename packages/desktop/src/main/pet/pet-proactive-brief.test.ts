import { describe, expect, test } from "bun:test";
import type { PetLongTask } from "@cjhyy/code-shell-pet";
import type { FollowUpRule } from "./pet-follow-up-rules.js";
import type { NoticeRecord } from "./pet-notice-ledger.js";
import {
  collectBrief,
  parseBriefWriteUp,
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
  });
});

describe("the write-up", () => {
  const facts = {
    kind: "morning" as const,
    records: [
      { ref: "r1", type: "decision" as const, title: "删库审批" },
      { ref: "r2", type: "done" as const, title: "写周报" },
    ],
  };

  test("every line names provided records, each at most once", () => {
    const valid = JSON.stringify({
      opening: "早！",
      items: [
        { refs: ["r1"], text: "删库那个等你审批" },
        { refs: ["r2"], text: "周报写完了" },
      ],
      closing: "今天先做哪个？",
    });
    expect(parseBriefWriteUp(valid, facts)).toEqual({
      opening: "早！",
      items: [
        { refs: ["r1"], text: "删库那个等你审批" },
        { refs: ["r2"], text: "周报写完了" },
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

  test("the model's write-up when valid; otherwise the next model; none: the template", async () => {
    const calls: string[] = [];
    const invalid = async () => {
      calls.push("aux");
      return JSON.stringify({ items: [{ refs: ["r3"], text: "不存在" }] });
    };
    const main = async ({ user }: { user: string }) => {
      calls.push("main");
      expect(JSON.parse(user).records).toHaveLength(2);
      return '```json\n{"items":[{"refs":["r1","r2"],"text":"审批一个，周报完了"}]}\n```';
    };
    expect(await writeBrief(facts, [invalid, main])).toEqual({
      text: "早上好，今天的情况：\n- 审批一个，周报完了",
      by: "model",
    });
    expect(calls).toEqual(["aux", "main"]);
    const down = async () => {
      throw new Error("no model");
    };
    expect(await writeBrief(facts, [down])).toEqual({ text: templateBrief(facts), by: "template" });
    expect(templateBrief(facts)).toBe(
      "早上好，今天的情况：\n- 「删库审批」等你决定\n- 「写周报」做完了",
    );
  });
});
