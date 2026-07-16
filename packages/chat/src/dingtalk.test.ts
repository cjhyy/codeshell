import { describe, expect, test } from "bun:test";
import { parseDingTalkTextMessage } from "./dingtalk.js";

describe("parseDingTalkTextMessage", () => {
  test("keeps discovery-safe conversation and sender metadata", () => {
    const message = parseDingTalkTextMessage(
      JSON.stringify({
        conversationId: "cid-test",
        conversationTitle: "测试群",
        conversationType: "2",
        senderStaffId: "staff-1",
        senderId: "fallback-user",
        senderNick: "小明",
        msgtype: "text",
        text: { content: "@机器人 你好" },
      }),
      "message-1",
    );

    expect(message).toEqual({
      channel: "dingtalk",
      target: "cid-test",
      senderId: "staff-1",
      text: "@机器人 你好",
      messageId: "message-1",
      metadata: {
        conversationTitle: "测试群",
        conversationType: "2",
        senderName: "小明",
      },
    });
  });

  test("ignores malformed and non-text frames", () => {
    expect(parseDingTalkTextMessage("not-json")).toBeUndefined();
    expect(
      parseDingTalkTextMessage(JSON.stringify({ conversationId: "cid-test", msgtype: "picture" })),
    ).toBeUndefined();
  });
});
