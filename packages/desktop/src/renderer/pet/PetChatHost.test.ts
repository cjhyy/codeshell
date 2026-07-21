import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PetDelegationCard, petDelegationDisplayState, selectPetChatRows } from "./PetChatHost";

describe("PetChatHost", () => {
  test("shows only the manager conversation and hides execution events", () => {
    expect(
      selectPetChatRows([
        { kind: "user", id: "u1", text: "帮我拆一下这个目标" },
        {
          kind: "tool",
          id: "tool1",
          toolName: "Read",
          args: "{}",
          status: "succeeded",
          startedAt: 1,
        },
        {
          kind: "assistant",
          id: "a1",
          text: "可以拆成两个独立任务\n<!--PET:AUTO_DELEGATE-->",
          done: true,
        },
      ]),
    ).toEqual([
      { id: "u1", role: "user", text: "帮我拆一下这个目标" },
      { id: "a1", role: "assistant", text: "可以拆成两个独立任务" },
    ]);
  });

  test("hides a partially streamed automatic-routing marker", () => {
    expect(
      selectPetChatRows([
        { kind: "assistant", id: "a1", text: "准备派发\n<!--PET:AU", done: false },
      ]),
    ).toEqual([{ id: "a1", role: "assistant", text: "准备派发" }]);
  });

  test("lets the manager chat shrink to its minimum before page scrolling begins", () => {
    const source = readFileSync(join(import.meta.dir, "PetChatHost.tsx"), "utf8");
    expect(source).toContain("min-h-[360px]");
    expect(source).not.toContain("min-h-[520px]");
  });

  test("places a structured delegation receipt after the matching assistant reply", () => {
    const rows = selectPetChatRows(
      [
        {
          kind: "user",
          id: "u1",
          text: "继续下载",
          clientMessageId: "pet-turn-1",
        },
        { kind: "assistant", id: "a1", text: "已派出。", done: true },
      ],
      [],
      [
        {
          originClientMessageId: "pet-turn-1",
          createdAt: 1,
          delegations: [
            {
              clientMessageId: "pet-turn-1",
              task: "继续下载 mimi-test-videos",
              workspacePath: "/work/codeshell",
              sessionId: "session-work-1",
              reusedSession: false,
            },
          ],
        },
      ],
    );

    expect(rows.map((row) => row.role)).toEqual(["user", "assistant", "delegation"]);
    expect(rows.at(-1)?.delegation).toMatchObject({
      sessionId: "session-work-1",
      task: "继续下载 mimi-test-videos",
    });
  });

  test("keeps automatic context compaction as an explicit history boundary", () => {
    expect(
      selectPetChatRows([
        { kind: "user", id: "u1", text: "old question" },
        {
          kind: "context_boundary",
          id: "ctx1",
          strategy: "summary",
          before: 12_000,
          after: 1_500,
        },
        { kind: "user", id: "u2", text: "new question" },
      ]),
    ).toEqual([
      { id: "u1", role: "user", text: "old question" },
      { id: "ctx1", role: "history-boundary", text: "", before: 12_000, after: 1_500 },
      { id: "u2", role: "user", text: "new question" },
    ]);
  });

  test("labels user messages received from an IM gateway channel", () => {
    expect(
      selectPetChatRows([
        {
          kind: "user",
          id: "u-im",
          text: "从微信发来的问题",
          clientMessageId: "im:wechat:message-hash",
        },
      ]),
    ).toEqual([{ id: "u-im", role: "user", text: "从微信发来的问题", source: "个人微信" }]);
  });

  test("inserts a segment divider and work-memory card before a boundary message", () => {
    const rows = selectPetChatRows(
      [
        { kind: "assistant", id: "a0", text: "上一段结论", done: true },
        { kind: "user", id: "u1", text: "新话题" },
        { kind: "assistant", id: "a1", text: "好的", done: true },
      ],
      [{ boundaryBeforeMessageId: "u1", brief: "未完成任务:\n- 重构 X" }],
    );
    const kinds = rows.map((r) => r.role);
    expect(kinds).toContain("segment-divider");
    expect(kinds).toContain("work-memory");
    // divider precedes the boundary user row
    const dividerIdx = rows.findIndex((r) => r.role === "segment-divider");
    const userIdx = rows.findIndex((r) => r.id === "u1");
    expect(dividerIdx).toBeLessThan(userIdx);
    // work-memory card sits between the divider and the boundary row
    const memoryIdx = rows.findIndex((r) => r.role === "work-memory");
    expect(dividerIdx).toBeLessThan(memoryIdx);
    expect(memoryIdx).toBeLessThan(userIdx);
    expect(rows.find((r) => r.role === "work-memory")?.text).toContain("重构 X");
  });

  test("inserts only a divider when the boundary segment has no brief", () => {
    const rows = selectPetChatRows(
      [
        { kind: "user", id: "u1", text: "新话题" },
        { kind: "assistant", id: "a1", text: "好的", done: true },
      ],
      [{ boundaryBeforeMessageId: "u1" }],
    );
    expect(rows.map((r) => r.role)).toEqual(["segment-divider", "user", "assistant"]);
  });

  test("renders no extra rows when there are no segments", () => {
    const rows = selectPetChatRows([
      { kind: "user", id: "u1", text: "问题" },
      { kind: "assistant", id: "a1", text: "答案", done: true },
    ]);
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
  });

  test("silently skips a boundary whose message id is not present", () => {
    const rows = selectPetChatRows(
      [{ kind: "user", id: "u1", text: "问题" }],
      [{ boundaryBeforeMessageId: "ghost", brief: "orphan brief" }],
    );
    expect(rows.map((r) => r.role)).toEqual(["user"]);
  });

  test("matches a boundary against the cross-process clientMessageId, not the local id", () => {
    // Main only ever knows the clientMessageId (the renderer-local Message.id is
    // invisible to it), so a production boundary keys on clientMessageId while
    // the transcript row carries a different freshId. The divider must still land.
    const rows = selectPetChatRows(
      [
        { kind: "assistant", id: "a0", text: "上一段", done: true },
        { kind: "user", id: "user-local-1", text: "新话题", clientMessageId: "pet-abc" },
        { kind: "assistant", id: "a1", text: "好的", done: true },
      ],
      [{ boundaryBeforeMessageId: "pet-abc", brief: "未完成任务:\n- 重构 X" }],
    );
    const kinds = rows.map((r) => r.role);
    expect(kinds).toContain("segment-divider");
    expect(kinds).toContain("work-memory");
    const dividerIdx = rows.findIndex((r) => r.role === "segment-divider");
    const userIdx = rows.findIndex((r) => r.id === "user-local-1");
    expect(dividerIdx).toBeLessThan(userIdx);
    expect(rows.find((r) => r.role === "work-memory")?.text).toContain("重构 X");
  });
});

describe("PetDelegationCard", () => {
  test("shows dispatch proof, live status, and a clickable Session affordance", () => {
    const html = renderToStaticMarkup(
      React.createElement(PetDelegationCard, {
        delegation: {
          clientMessageId: "pet-turn-1",
          task: "继续下载 mimi-test-videos",
          workspacePath: "/work/codeshell",
          sessionId: "secret-session-id",
          reusedSession: false,
        },
        session: {
          agentSessionId: "secret-session-id",
          title: "mimi-test-videos",
          workspaceDisplayName: "codeshell",
          runState: "running",
          queueDepth: 0,
          lastActivityAt: 1,
          pendingDecisionCount: 0,
          freshness: { source: "live-event", observedAt: 1, workerState: "active" },
        },
        onOpen: () => {},
      }),
    );

    expect(html).toContain('data-pet-delegation-card="true"');
    expect(html).toContain("已派出 Session");
    expect(html).toContain("执行中");
    expect(html).toContain("打开 Session");
    expect(html).not.toContain("secret-session-id");
    expect(html).not.toContain("<button disabled");
  });

  test("maps terminal outcomes to their explicit card state", () => {
    expect(
      petDelegationDisplayState({
        agentSessionId: "failed",
        runState: "terminal",
        queueDepth: 0,
        lastActivityAt: 1,
        pendingDecisionCount: 0,
        terminal: { status: "failed", at: 1 },
        freshness: { source: "disk", observedAt: 1, workerState: "reclaimed" },
      }),
    ).toBe("failed");
  });
});
