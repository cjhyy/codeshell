import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TurnProcessGroupCard } from "./TurnProcessGroupCard";
import { buildStreamItems, type RenderedTurnProcessGroup } from "./streamGroups";
import type { Message, ToolMessage, UserMessage } from "../types";

const followUp = "完成后请读取 eval-note.txt；不要再修改文件。";
function steer(overrides: Partial<UserMessage> = {}): UserMessage {
  return {
    kind: "user",
    id: "user-follow-up",
    text: followUp,
    steerId: "steer-follow-up",
    clientMessageId: "client-follow-up",
    injected: true,
    pending: false,
    ...overrides,
  };
}
function tool(name: string): ToolMessage {
  return {
    kind: "tool",
    id: `tool-${name}`,
    toolName: name,
    args: "{}",
    result: "ok",
    status: "succeeded",
    startedAt: 1,
    endedAt: 2,
  };
}
function group(users: UserMessage[] = [steer()], live = false): RenderedTurnProcessGroup {
  const messages: Message[] = [
    { kind: "user", id: "first", text: "创建 eval-note.txt", clientMessageId: "client-first" },
    tool("Write"),
    ...users,
    tool("Read"),
    { kind: "assistant", id: "answer", text: "文件内容已读取。", done: !live },
  ];
  const groups = buildStreamItems(messages, { liveTurnActive: live });
  return groups.find((item) => item.kind === "turn_process_group") as RenderedTurnProcessGroup;
}

describe("TurnProcessGroupCard confirmed user steers", () => {
  test("closed Write → steer → Read keeps the actual request visible beside collapsed tools", () => {
    const html = renderToStaticMarkup(<TurnProcessGroupCard group={group()} />);
    expect(html).toContain('aria-expanded="false"');
    expect(html.split(followUp).length - 1).toBe(1);
    expect(html).not.toContain('data-message-kind="tool"');
    expect(html).not.toContain("正在读取");
  });

  test("the same confirmed request renders only once while the original turn remains live", () => {
    const live = group([steer()], true);
    expect(live.isLive).toBe(true);
    const html = renderToStaticMarkup(<TurnProcessGroupCard group={live} />);
    expect(html).toContain('aria-expanded="true"');
    expect(html.split(followUp).length - 1).toBe(1);
  });

  test("pending steers and system reminders remain outside the collapsed user summary", () => {
    const html = renderToStaticMarkup(
      <TurnProcessGroupCard
        group={group([
          steer({ pending: true }),
          steer({
            id: "reminder",
            steerId: "reminder",
            text: "<system-reminder>internal reminder</system-reminder>",
          }),
          steer({ id: "wakeup", steerId: undefined, text: "internal wakeup" }),
        ])}
      />,
    );
    expect(html).not.toContain(followUp);
    expect(html).not.toContain("internal reminder");
    expect(html).not.toContain("internal wakeup");
  });

  test("two genuine requests with identical text and distinct identities both remain visible", () => {
    const html = renderToStaticMarkup(
      <TurnProcessGroupCard
        group={group([
          steer(),
          steer({ id: "second-user", steerId: "second-steer", clientMessageId: "second-client" }),
        ])}
      />,
    );
    expect(html.split(followUp).length - 1).toBe(2);
  });
});
