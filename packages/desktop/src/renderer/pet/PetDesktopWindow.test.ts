import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PetMiniMarkdown, selectMiniChatMessages, selectMiniChatRows } from "./PetDesktopWindow";

describe("Pet desktop mini chat", () => {
  test("projects the shared durable transcript into compact chat bubbles", () => {
    expect(
      selectMiniChatMessages([
        { kind: "user", id: "u1", text: "安排修复" },
        { kind: "thinking", id: "t1", text: "scope", done: true },
        {
          kind: "assistant",
          id: "a1",
          text: "我会先整理范围\n<!--PET:AUTO_DELEGATE-->",
          done: true,
        },
      ]),
    ).toEqual([
      { id: "u1", role: "user", text: "安排修复" },
      { id: "a1", role: "assistant", text: "我会先整理范围" },
    ]);
  });

  test("keeps Mimi chat and requested work bubbles as separate content", () => {
    const source = readFileSync(join(import.meta.dir, "PetDesktopWindow.tsx"), "utf8");
    expect(source).toContain("<PetActivityPreview");
    expect(source).toContain('panel ? "expanded" : "collapsed"');
    expect(source).toContain("const state = usePetProjectionState(api)");
    expect(source).toContain('type PetMiniPanel = "chat" | "activity" | null');
    expect(source).toContain('data-pet-mini-panel-content="chat"');
    expect(source).toContain('panel === "activity"');
    expect(source).toContain('data-pet-activity-bubbles="true"');
    expect(source).toContain('data-pet-activity-stack="collapsed"');
    expect(source).toContain("workActivity.items.length > 1 && !activityListExpanded");
    expect(source).toContain("setActivityListExpanded(true)");
    expect(source).toContain("workActivity.items.map");
    expect(source).not.toContain("<SessionStatusSection");
    expect(source).not.toContain("globalOverview");
    expect(source).not.toContain("onAttentionEvent");
    expect(source).toContain("chatRows.slice(-6).map");
    expect(source).toContain('panel === "chat"');
    expect(source).toContain("markPetWidgetCompletionSeen");
    expect(source).toContain('window.addEventListener("storage", syncReceipts)');
    expect(source).toContain('if (item.kind !== "completed") return');
    expect(source).toContain('if (item.kind === "completed")');
    expect(source).toContain("closePanel()");
    expect(source).toContain("onDismiss={() => dismissActivity");
    expect(source).toContain("if (activityItem) markCompletionSeen(activityItem)");
    expect(source).not.toContain("void api.getSnapshot()");
  });

  test("renders delegation receipts as compact live session cards", () => {
    const rows = selectMiniChatRows(
      [
        { kind: "user", id: "u1", text: "去下载视频", clientMessageId: "client-1" },
        { kind: "assistant", id: "a1", text: "已经派出去了", done: true },
      ],
      [
        {
          originClientMessageId: "client-1",
          delegations: [
            {
              sessionId: "session-1",
              task: "下载视频",
              workspacePath: "/tmp/video",
              reusedSession: false,
            },
          ],
        },
      ],
    );

    expect(rows.map((row) => row.role)).toEqual(["user", "assistant", "delegation"]);
    expect(rows.at(-1)?.delegation?.sessionId).toBe("session-1");

    const source = readFileSync(join(import.meta.dir, "PetDesktopWindow.tsx"), "utf8");
    expect(source).toContain("<PetDelegationCard");
    expect(source).toContain("compact");
    expect(source).toContain("onOpen={() => openDelegation");
  });

  test("omits all transcript rows hidden by the latest context compaction", () => {
    const rows = selectMiniChatRows([
      { kind: "user", id: "old-u", text: "旧问题" },
      { kind: "assistant", id: "old-a", text: "旧回答", done: true },
      {
        kind: "context_boundary",
        id: "ctx-1",
        strategy: "summary",
        before: 12_000,
        after: 1_200,
      },
      { kind: "user", id: "new-u", text: "新问题" },
      { kind: "assistant", id: "new-a", text: "新回答", done: true },
    ]);

    expect(rows.map((row) => row.id)).toEqual(["new-u", "new-a"]);
  });

  test("omits rows before the latest Mimi topic-segment boundary", () => {
    const rows = selectMiniChatRows(
      [
        { kind: "user", id: "old-u", text: "旧话题", clientMessageId: "old-message" },
        { kind: "assistant", id: "old-a", text: "旧回答", done: true },
        { kind: "user", id: "new-u", text: "新话题", clientMessageId: "new-message" },
        { kind: "assistant", id: "new-a", text: "新回答", done: true },
      ],
      [],
      [{ boundaryBeforeMessageId: "new-message", brief: "上一段纪要" }],
    );

    expect(rows.map((row) => row.id)).toEqual(["new-u", "new-a"]);
  });

  test("hides a seen completion closure and keeps only later conversation", () => {
    const rows = selectMiniChatRows(
      [
        { kind: "user", id: "request", text: "查 JPEG", clientMessageId: "im:jpeg" },
        { kind: "assistant", id: "accepted", text: "已派出", done: true },
        {
          kind: "user",
          id: "closure",
          text: "internal closure",
          clientMessageId: "pet-closure:pet-task-jpeg:1:completed:nonce",
        },
        { kind: "assistant", id: "result", text: "JPEG 调查结果", done: true },
        { kind: "user", id: "later-u", text: "新的问题", clientMessageId: "pet-later" },
        { kind: "assistant", id: "later-a", text: "新的回答", done: true },
      ],
      [],
      [],
      {
        revision: 1,
        observedAt: 500,
        tasks: [
          {
            schemaVersion: 1,
            id: "pet-task-jpeg",
            originClientMessageId: "im:jpeg",
            objective: "查 JPEG",
            workspacePath: "/work",
            sessionId: "work-jpeg",
            verificationMode: "turn",
            status: "completed",
            phase: "finalizing",
            attempt: 1,
            revision: 2,
            createdAt: 100,
            updatedAt: 300,
            completedAt: 300,
            artifacts: [],
            events: [],
          },
        ],
      },
      { baselineAt: 50, seenCompletionKeys: ["completed-task:pet-task-jpeg:300"] },
    );

    expect(rows.map((row) => row.id)).toEqual(["later-u", "later-a"]);
  });

  test("keeps an unread completion result visible", () => {
    const messages: Message[] = [
      {
        kind: "user",
        id: "closure",
        text: "internal closure",
        clientMessageId: "pet-closure:pet-task-new:1:completed:nonce",
      },
      { kind: "assistant", id: "result", text: "尚未查看的结果", done: true },
    ];
    const rows = selectMiniChatRows(
      messages,
      [],
      [],
      {
        revision: 1,
        observedAt: 500,
        tasks: [
          {
            schemaVersion: 1,
            id: "pet-task-new",
            originClientMessageId: "im:new",
            objective: "新任务",
            workspacePath: "/work",
            sessionId: "work-new",
            verificationMode: "turn",
            status: "completed",
            phase: "finalizing",
            attempt: 1,
            revision: 2,
            createdAt: 100,
            updatedAt: 300,
            completedAt: 300,
            artifacts: [],
            events: [],
          },
        ],
      },
      {
        baselineAt: 50,
        seenCompletionKeys: [],
      },
    );

    expect(rows.map((row) => row.id)).toEqual(["closure", "result"]);
  });

  test("renders assistant markdown in the mini chat", () => {
    const html = renderToStaticMarkup(
      React.createElement(PetMiniMarkdown, {
        text: "已派到 **codeshell workspace**，检查 `probeJpeg()`。",
      }),
    );

    expect(html).toContain("<strong>codeshell workspace</strong>");
    expect(html).toContain("<code>probeJpeg()</code>");
    expect(html).not.toContain("**codeshell workspace**");
  });
});
