import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildPetMessageWithPathAttachments,
  MAX_PET_PATH_ATTACHMENTS,
  normalizePetPathAttachments,
  parsePetUserContent,
  PetChatMarkdown,
  PetDeliveryStatusTip,
  PetDelegationCard,
  petDelegationDisplayState,
  selectPetChatRows,
} from "./PetChatHost";
import { markPetHostActionReplacementDisplay } from "../../shared/pet-host-action-receipt";

describe("PetChatHost", () => {
  test("keeps dropped PDFs as bounded absolute path references", () => {
    const paths = normalizePetPathAttachments([
      "/Users/maki/Documents/spec.pdf",
      "/Users/maki/Documents/spec.pdf",
      "relative/spec.pdf",
      "C:\\Users\\maki\\report.pdf",
      "bad\npath.pdf",
      ...Array.from({ length: 20 }, (_, index) => `/tmp/file-${index}.pdf`),
    ]);

    expect(paths).toEqual([
      "/Users/maki/Documents/spec.pdf",
      "C:\\Users\\maki\\report.pdf",
      ...Array.from(
        { length: MAX_PET_PATH_ATTACHMENTS - 2 },
        (_, index) => `/tmp/file-${index}.pdf`,
      ),
    ]);
  });

  test("allows a file-only Mimi turn and preserves paths exactly", () => {
    expect(
      buildPetMessageWithPathAttachments(
        "",
        ["/Users/maki/My PDFs/quarterly report.pdf"],
        "本地文件路径（由你拖入）",
      ),
    ).toBe('本地文件路径（由你拖入）:\n- "/Users/maki/My PDFs/quarterly report.pdf"');
  });

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

  test("never flashes Mimi's post-delegation internal acknowledgement", () => {
    expect(
      selectPetChatRows([
        {
          kind: "user",
          id: "u1",
          text: "继续处理这个任务",
          clientMessageId: "pet-turn-delegate",
        },
        { kind: "assistant", id: "a1", text: "我先确认续接目标。", done: true },
        {
          kind: "tool",
          id: "tool1",
          toolName: "DelegateWork",
          args: "{}",
          result: "Delegation accepted",
          status: "succeeded",
          startedAt: 1,
        },
        {
          kind: "assistant",
          id: "a2",
          text: "微信消息已发送。系统提示当前没有活跃任务，待命。",
          done: true,
        },
      ]),
    ).toEqual([
      { id: "u1", role: "user", text: "继续处理这个任务" },
      { id: "a1", role: "assistant", text: "我先确认续接目标。" },
    ]);
  });

  test("keeps pre-tool context when the authoritative delegation receipt arrives", () => {
    const messages = [
      {
        kind: "user" as const,
        id: "u1",
        text: "继续处理这个任务",
        clientMessageId: "pet-turn-delegate",
      },
      { kind: "assistant" as const, id: "a1", text: "我先确认续接目标。", done: true },
      {
        kind: "tool" as const,
        id: "tool1",
        toolName: "DelegateWork",
        args: "{}",
        result: "Delegation accepted",
        status: "succeeded" as const,
        startedAt: 1,
      },
      {
        kind: "assistant" as const,
        id: "a2",
        text: "内部结束语，不应显示。",
        done: true,
      },
    ];

    expect(
      selectPetChatRows(
        messages,
        [],
        [],
        [
          {
            clientMessageId: "pet-turn-delegate",
            message: "原任务已继续执行，正在处理。",
            createdAt: 2,
            replaceAssistant: true,
          },
        ],
      ).map((row) => row.text),
    ).toEqual(["继续处理这个任务", "我先确认续接目标。", "原任务已继续执行，正在处理。"]);
  });

  test("renders Mimi assistant content as sanitized GFM markdown", () => {
    const html = renderToStaticMarkup(
      React.createElement(PetChatMarkdown, {
        text: "## 结论\n\n- 已修复 **Markdown**\n- 调用 `render()`\n\n<script>alert(1)</script>",
      }),
    );

    expect(html).toContain("结论</h2>");
    expect(html).toContain("<li>已修复 <strong>Markdown</strong></li>");
    expect(html).toContain("<code>render()</code>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("**Markdown**");
  });

  test("lets the manager chat shrink to its minimum before page scrolling begins", () => {
    const source = readFileSync(join(import.meta.dir, "PetChatHost.tsx"), "utf8");
    expect(source).toContain("min-h-[360px]");
    expect(source).not.toContain("min-h-[520px]");
    expect(source).toContain("pathForRendererFile(file)");
    expect(source).toContain('data-pet-path-attachments="true"');
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

  test("places a host-action receipt after its originating turn instead of after later chat", () => {
    const rows = selectPetChatRows(
      [
        {
          kind: "user",
          id: "u1",
          text: "完成跟进项",
          clientMessageId: "pet-turn-1",
        },
        { kind: "assistant", id: "a1", text: "我来处理。", done: true },
        {
          kind: "user",
          id: "u2",
          text: "下一件事",
          clientMessageId: "pet-turn-2",
        },
        { kind: "assistant", id: "a2", text: "请说。", done: true },
      ],
      [],
      [],
      [
        {
          clientMessageId: "pet-turn-1",
          message: "跟进项已完成：「整理发布说明」。",
          createdAt: 2,
        },
      ],
    );

    expect(rows.map((row) => row.text)).toEqual([
      "完成跟进项",
      "我来处理。",
      "跟进项已完成：「整理发布说明」。",
      "下一件事",
      "请说。",
    ]);
  });

  test("replaces Mimi's premature sent claim with the authoritative outbound failure", () => {
    const rows = selectPetChatRows(
      [
        {
          kind: "user",
          id: "u1",
          text: "给微信发测试消息",
          clientMessageId: "pet-turn-send",
        },
        {
          kind: "assistant",
          id: "a1",
          text: "测试消息已经通过 SendMessage 发出去了。",
          done: true,
        },
      ],
      [],
      [],
      [
        {
          clientMessageId: "pet-turn-send",
          message: "主动消息操作失败：微信发送准备失败",
          createdAt: 2,
          replaceAssistant: true,
        },
      ],
    );

    expect(rows.map((row) => row.text)).toEqual([
      "给微信发测试消息",
      "主动消息操作失败：微信发送准备失败",
    ]);
  });

  test("keeps outbound replacement semantics after transcript hydration", () => {
    const rows = selectPetChatRows([
      {
        kind: "user",
        id: "u1",
        text: "给微信发测试消息",
        clientMessageId: "pet-turn-send",
      },
      {
        kind: "assistant",
        id: "a1",
        text: "测试消息已经发出去了。",
        done: true,
      },
      {
        kind: "assistant",
        id: "receipt",
        text: markPetHostActionReplacementDisplay("主动消息操作失败：微信发送准备失败"),
        done: true,
      },
    ]);

    expect(rows.map((row) => row.text)).toEqual([
      "给微信发测试消息",
      "主动消息操作失败：微信发送准备失败",
    ]);
  });

  test("uses the persisted source id when a delayed receipt follows a newer turn", () => {
    const rows = selectPetChatRows([
      {
        kind: "user",
        id: "u1",
        text: "给微信发测试消息",
        clientMessageId: "pet-turn-send",
      },
      {
        kind: "assistant",
        id: "a1",
        text: "测试消息已经发出去了。",
        done: true,
      },
      {
        kind: "user",
        id: "u2",
        text: "再查一下进度",
        clientMessageId: "pet-turn-check",
      },
      {
        kind: "assistant",
        id: "a2",
        text: "还在查。",
        done: true,
      },
      {
        kind: "assistant",
        id: "receipt",
        text: markPetHostActionReplacementDisplay(
          "主动消息操作失败：微信发送准备失败",
          "pet-turn-send",
        ),
        done: true,
      },
    ]);

    expect(rows.map((row) => row.text)).toEqual([
      "给微信发测试消息",
      "主动消息操作失败：微信发送准备失败",
      "再查一下进度",
      "还在查。",
    ]);
  });

  test("shows the WeChat reply body, keeps the dispatch update, and separates delivery status", () => {
    const rows = selectPetChatRows(
      [
        {
          kind: "user",
          id: "u1",
          text: "帮我分析这篇文章",
          clientMessageId: "im:wechat:message-one",
        },
        { kind: "assistant", id: "a1", text: "任务已派出，完成后发给你。", done: true },
        {
          kind: "assistant",
          id: "a2",
          text: "微信消息已发送。系统提示当前没有活跃任务，待命。",
          done: true,
        },
      ],
      [],
      [],
      [
        {
          clientMessageId: "im:wechat:message-one",
          message: "Mooncake 的核心是用 KVCache 换取更少的重复计算。",
          createdAt: 3,
          replaceAssistant: true,
          deliveryChannel: "wechat",
        },
      ],
    );

    expect(rows.map((row) => row.text)).toEqual([
      "帮我分析这篇文章",
      "任务已派出，完成后发给你。",
      "Mooncake 的核心是用 KVCache 换取更少的重复计算。",
    ]);
    expect(rows.at(-1)?.deliveryLabel).toBe("个人微信");
    expect(
      renderToStaticMarkup(React.createElement(PetDeliveryStatusTip, { label: "个人微信" })),
    ).toContain("已发送到个人微信");
  });

  test("restores the WeChat delivery tip from a persisted replacement receipt", () => {
    const rows = selectPetChatRows([
      {
        kind: "user",
        id: "u1",
        text: "帮我分析文章",
        clientMessageId: "im:wechat:message-two",
      },
      { kind: "assistant", id: "a1", text: "任务已派出。", done: true },
      {
        kind: "assistant",
        id: "a2",
        text: "微信消息已发送。系统提示当前没有活跃任务，待命。",
        done: true,
      },
      {
        kind: "assistant",
        id: "receipt",
        text: markPetHostActionReplacementDisplay(
          "这是发送给微信的原文。",
          "im:wechat:message-two",
          "wechat",
        ),
        done: true,
      },
    ]);

    expect(rows.map((row) => row.text)).toEqual([
      "帮我分析文章",
      "任务已派出。",
      "这是发送给微信的原文。",
    ]);
    expect(rows.at(-1)?.deliveryLabel).toBe("个人微信");
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

  test("turns a persisted IM image attachment into a Mimi chat image bubble", () => {
    const absolutePath =
      "/Users/maki/.code-shell/no-repo/.code-shell/attachments/pet-one/wechat-image.jpg";
    const content = parsePetUserContent({
      kind: "user",
      id: "u-image",
      text: `<attached-file path=".code-shell/attachments/pet-one/wechat-image.jpg">
absolutePath: ${absolutePath}
mime: image/jpeg
size: 207674
sha256: abc
origin: im-gateway
</attached-file>`,
      clientMessageId: "im:wechat:image-one",
    });

    expect(content).toEqual({
      text: "",
      images: [
        {
          path: absolutePath,
          name: "wechat-image.jpg",
          mime: "image/jpeg",
          cwd: "/Users/maki/.code-shell/no-repo",
          sessionId: "pet-one",
        },
      ],
    });
    expect(
      selectPetChatRows([
        {
          kind: "user",
          id: "u-image",
          text: `<attached-file path="image.jpg">\nabsolutePath: ${absolutePath}\nmime: image/jpeg\n</attached-file>`,
          clientMessageId: "im:wechat:image-one",
        },
      ]),
    ).toMatchObject([
      {
        id: "u-image",
        role: "user",
        text: "",
        source: "\u4e2a\u4eba\u5fae\u4fe1",
        images: [{ path: absolutePath }],
      },
    ]);
  });

  test("shows a live structured image immediately and keeps its caption", () => {
    const absolutePath = "/work/.code-shell/attachments/pet-live/photo.png";
    expect(
      parsePetUserContent({
        kind: "user",
        id: "u-live-image",
        text: "\u5e2e\u6211\u770b\u8fd9\u5f20\u56fe",
        attachments: [
          {
            kind: "image",
            path: ".code-shell/attachments/pet-live/photo.png",
            absPath: absolutePath,
            sessionId: "pet-live",
            mime: "image/png",
            originalName: "photo.png",
          },
        ],
      }),
    ).toEqual({
      text: "\u5e2e\u6211\u770b\u8fd9\u5f20\u56fe",
      images: [
        {
          path: absolutePath,
          name: "photo.png",
          mime: "image/png",
          cwd: "/work",
          sessionId: "pet-live",
        },
      ],
    });
  });

  test("keeps non-image attachment metadata as text", () => {
    const text = `<attached-file path="doc.pdf">
absolutePath: /work/.code-shell/attachments/pet-one/doc.pdf
mime: application/pdf
</attached-file>`;
    expect(parsePetUserContent({ kind: "user", id: "u-file", text })).toEqual({
      text,
      images: [],
    });
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
