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
});
