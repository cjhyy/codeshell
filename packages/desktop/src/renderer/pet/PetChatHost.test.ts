import { describe, expect, test } from "bun:test";
import { selectPetChatRows } from "./PetChatHost";

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
});
