import { describe, expect, test } from "bun:test";
import type { FollowUpRule } from "./pet-follow-up-rules.js";
import type { NoticeRecord } from "./pet-notice-ledger.js";
import {
  heartbeatPrecheck,
  judgeHeartbeat,
  parseHeartbeatJudgement,
  type HeartbeatInputs,
} from "./pet-proactive-heartbeat.js";
import type { DesktopPetSession } from "./pet-state-aggregator.js";

const MIN = 60_000;
const NOW = Date.UTC(2023, 10, 15, 10, 0);
const SINCE = NOW - 30 * MIN;

function record(overrides: Partial<NoticeRecord>): NoticeRecord {
  return {
    id: "n",
    kind: "session.done",
    priority: "P1",
    dedupeKey: "k",
    ruleIds: [],
    facts: { title: "修登录", target: { kind: "owner" } },
    createdAt: NOW - 10 * MIN,
    sessionId: "s1",
    ...overrides,
  } as NoticeRecord;
}

function inputs(overrides: Partial<HeartbeatInputs> = {}): HeartbeatInputs {
  return {
    now: NOW,
    since: SINCE,
    seen: new Set(),
    recent: [],
    followUps: [],
    sessions: [],
    sessionWatched: () => true,
    wasSessionViewedSince: () => false,
    ...overrides,
  };
}

function resume(occurrence: number, sourceSessionId = "s9"): FollowUpRule {
  return {
    id: "rule-f",
    version: 1,
    origin: "user",
    createdBy: "follow-up",
    when: { kind: "schedule", at: occurrence, timezone: "UTC", missedPolicy: "fire-once" },
    then: { mode: "run-mimi", title: "续办部署", text: "看下部署", sourceSessionId },
    wake: { occurrence, status: "scheduled" },
    attention: "always",
    channel: "auto",
    target: { kind: "owner" },
    state: "active",
    createdAt: 0,
    updatedAt: 0,
  } as FollowUpRule;
}

describe("heartbeatPrecheck", () => {
  test("time passing alone is no fact", () => {
    expect(heartbeatPrecheck(inputs())).toEqual([]);
  });

  test("a watched Session's new decision whose first prompt did not get through", () => {
    const prompt = { code: "AAAAAAAAAAAA", phase: "desktop" } as const;
    const blocked = (status: string, extra: Partial<NoticeRecord> = {}) =>
      record({
        id: `b-${status}`,
        kind: "session.blocked",
        requestId: "r",
        prompt,
        delivery: { key: "0".repeat(24), status, attempts: 1, at: NOW } as never,
        ...extra,
      });
    const facts = heartbeatPrecheck(
      inputs({
        recent: [
          blocked("failed"),
          blocked("accepted"),
          blocked("queued", {
            createdAt: SINCE - 10,
            delivery: {
              key: "0".repeat(24),
              status: "queued",
              attempts: 1,
              at: SINCE - 5,
            } as never,
          }),
          blocked("held", { prompt: { ...prompt, phase: "answered" } }),
          blocked("unknown", { sessionId: "unwatched" }),
        ],
        sessionWatched: (id) => id !== "unwatched",
      }),
    );
    expect(facts.map((fact) => [fact.type, fact.key])).toEqual([
      ["blocked-undelivered", "blocked:b-failed"],
    ]);
  });

  test("a prompt created before the last heartbeat whose send failed after it is new", () => {
    const facts = heartbeatPrecheck(
      inputs({
        recent: [
          record({
            id: "late-fail",
            kind: "session.blocked",
            requestId: "r",
            createdAt: SINCE - 20 * MIN,
            prompt: { code: "AAAAAAAAAAAA", phase: "desktop" },
            delivery: {
              key: "0".repeat(24),
              status: "failed",
              attempts: 1,
              at: SINCE + MIN,
            } as never,
          }),
        ],
      }),
    );
    expect(facts).toMatchObject([{ key: "blocked:late-fail", at: SINCE + MIN }]);
  });

  test("over the bound, the newest facts are kept", () => {
    const recent = Array.from({ length: 15 }, (_, index) =>
      record({ id: `n${index}`, sessionId: `s${index}`, createdAt: SINCE + (index + 1) * MIN }),
    );
    const facts = heartbeatPrecheck(inputs({ recent }));
    expect(facts).toHaveLength(12);
    expect(facts[0]!.key).toBe("result:n3");
    expect(facts.at(-1)!.key).toBe("result:n14");
  });

  test("a result since the last heartbeat the owner has not looked at (one per Session)", () => {
    const facts = heartbeatPrecheck(
      inputs({
        recent: [
          record({ id: "old", createdAt: NOW - 20 * MIN }),
          record({ id: "new", createdAt: NOW - 5 * MIN, kind: "session.failed" }),
          record({ id: "seen-it", sessionId: "s2" }),
          record({ id: "digest", kind: "digest", sessionId: undefined }),
        ],
        wasSessionViewedSince: (id) => id === "s2",
      }),
    );
    expect(facts.map((fact) => [fact.type, fact.key, fact.detail])).toEqual([
      ["result-unviewed", "result:new", "没做完，你还没看"],
    ]);
  });

  test("a follow-up due within 2 h whose Session has been idle that long", () => {
    const idle = {
      agentSessionId: "s9",
      runState: "idle",
      lastActivityAt: NOW - 3 * 60 * MIN,
    } as DesktopPetSession;
    const facts = (followUps: FollowUpRule[], sessions: DesktopPetSession[] = [idle]) =>
      heartbeatPrecheck(inputs({ followUps, sessions })).map((fact) => fact.type);
    expect(facts([resume(NOW + 90 * MIN)])).toEqual(["follow-up-idle"]);
    expect(facts([resume(NOW + 3 * 60 * MIN)])).toEqual([]);
    expect(facts([resume(NOW + 90 * MIN)], [{ ...idle, lastActivityAt: NOW - 30 * MIN }])).toEqual(
      [],
    );
    expect(
      facts([resume(NOW + 90 * MIN)], [{ ...idle, runState: "running" } as DesktopPetSession]),
    ).toEqual([]);
  });

  test("a fact already judged is not new", () => {
    const recent = [record({ id: "new" })];
    expect(heartbeatPrecheck(inputs({ recent, seen: new Set(["result:new"]) }))).toEqual([]);
  });
});

describe("the judgement", () => {
  test("strict schema: say needs text, silence may ask for one recheck (bounded)", () => {
    expect(parseHeartbeatJudgement('{"say":true,"text":"部署那个结果出来了"}')).toEqual({
      say: true,
      text: "部署那个结果出来了",
    });
    expect(parseHeartbeatJudgement('{"say":false}')).toEqual({ say: false });
    expect(parseHeartbeatJudgement('{"say":false,"recheckInMin":5}')).toEqual({
      say: false,
      recheckInMin: 10,
    });
    expect(parseHeartbeatJudgement('{"say":false,"recheckInMin":600}')).toEqual({
      say: false,
      recheckInMin: 120,
    });
    for (const bad of [
      '{"say":true}',
      '{"say":true,"text":""}',
      '{"say":true,"text":"x","recheckInMin":20}',
      '{"say":false,"text":"x"}',
      '{"say":false,"recheckInMin":1.5}',
      '{"say":"yes"}',
      '{"say":false,"why":"x"}',
      "不用说",
    ])
      expect(parseHeartbeatJudgement(bad)).toBeUndefined();
  });

  test("facts go to the model as data; an invalid answer falls through to the next model", async () => {
    const seen: string[] = [];
    const result = await judgeHeartbeat(
      [{ key: "result:new", type: "result-unviewed", title: "修登录", at: NOW, sessionId: "s1" }],
      { now: NOW, saidToday: 1, offsetMin: () => 480 },
      [
        async () => "maybe",
        async ({ user }) => {
          seen.push(user);
          return '{"say":false}';
        },
      ],
    );
    expect(result).toEqual({ say: false });
    const payload = JSON.parse(seen[0]!);
    expect(payload.saidToday).toBe(1);
    // The owner's clock (UTC+8 here), not UTC or epoch ms.
    expect(payload.now).toBe("2023-11-15T18:00:00+08:00");
    expect(payload.facts[0]).toEqual({
      type: "result-unviewed",
      title: "修登录",
      at: "2023-11-15T18:00:00+08:00",
      sessionId: "s1",
    });
  });
});
