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
