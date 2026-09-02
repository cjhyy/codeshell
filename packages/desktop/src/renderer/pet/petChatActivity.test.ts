import { describe, expect, test } from "bun:test";
import type { TFunction } from "../i18n";
import { translate } from "../i18n";
import type { Message, ToolMessage } from "../types";
import { describePetChatActivity } from "./petChatActivity";

const zh: TFunction = (key, params) => translate("zh", key, params);

function user(): Message {
  return { kind: "user", id: "user", text: "帮我处理" };
}

function tool(overrides: Partial<ToolMessage>): ToolMessage {
  return {
    kind: "tool",
    id: "tool",
    toolName: "Sessions",
    args: "{}",
    status: "running",
    startedAt: 1,
    ...overrides,
  };
}

describe("describePetChatActivity", () => {
  test("shows a concrete request-understanding phase before tools start", () => {
    expect(describePetChatActivity([user()], zh)).toEqual({
      text: "正在理解你的请求…",
      phase: "understanding",
    });
  });

  test("shows the actual Session search and query while its tool is running", () => {
    expect(
      describePetChatActivity(
        [
          user(),
          tool({
            args: JSON.stringify({ action: "search", query: "登录失败" }),
          }),
        ],
        zh,
      ),
    ).toEqual({
      text: "正在搜索 Session：登录失败…",
      phase: "working",
      toolName: "Sessions",
    });
  });

  test("distinguishes resuming an existing Session from a new dispatch", () => {
    expect(
      describePetChatActivity(
        [
          user(),
          tool({
            toolName: "DelegateWork",
            args: JSON.stringify({ session_id: "session-1", objective: "继续修复登录问题" }),
          }),
        ],
        zh,
      ).text,
    ).toBe("正在接续 Session：继续修复登录问题…");
  });

  test("keeps the latest concrete milestone visible between tool steps", () => {
    expect(
      describePetChatActivity(
        [
          user(),
          tool({
            args: JSON.stringify({ action: "search", query: "登录失败" }),
            status: "succeeded",
          }),
        ],
        zh,
      ),
    ).toEqual({
      text: "已完成：Session 搜索：登录失败。正在继续处理…",
      phase: "continuing",
      toolName: "Sessions",
    });
  });

  test("uses existing detailed activity text for ordinary coding tools", () => {
    expect(
      describePetChatActivity(
        [
          user(),
          tool({
            toolName: "Read",
            args: JSON.stringify({ file_path: "/work/src/login.ts" }),
          }),
        ],
        zh,
      ).text,
    ).toBe("正在读取 login.ts");
  });
});
