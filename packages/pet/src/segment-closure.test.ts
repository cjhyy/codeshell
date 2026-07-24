import { describe, expect, test } from "bun:test";
import {
  buildClosureInput,
  locateClosureWindow,
  parseClosureResponse,
  type ClosureMessage,
} from "./segment-closure.js";

const messages: ClosureMessage[] = [
  { role: "user", text: "早上的任务", clientMessageId: "c0" },
  { role: "assistant", text: "好的，开始" },
  { role: "user", text: "继续", clientMessageId: "c1" },
  { role: "assistant", text: "完成了" },
  { role: "user", text: "新话题", clientMessageId: "c2" },
  { role: "assistant", text: "收到" },
];

describe("locateClosureWindow", () => {
  test("slices between the closing boundary and the next boundary", () => {
    const window = locateClosureWindow(messages, "c0", "c2");
    expect(window?.range).toEqual({ start: 0, end: 4 });
    expect(window?.messages.map((m) => m.text)).toEqual([
      "早上的任务",
      "好的，开始",
      "继续",
      "完成了",
    ]);
  });

  test("runs a closing boundary to the end of the transcript", () => {
    const window = locateClosureWindow(messages, "c2", undefined);
    expect(window?.range).toEqual({ start: 4, end: 6 });
    expect(window?.messages.map((m) => m.text)).toEqual(["新话题", "收到"]);
  });

  test("treats an absent closing boundary as starting at index 0", () => {
    const window = locateClosureWindow(messages, undefined, "c1");
    expect(window?.range).toEqual({ start: 0, end: 2 });
  });

  test("returns null when a boundary id is not in the transcript or window is empty", () => {
    expect(locateClosureWindow(messages, "missing", "c2")).toBeNull();
    expect(locateClosureWindow(messages, "c2", "c0")).toBeNull();
    expect(locateClosureWindow(messages, "c0", "c0")).toBeNull();
  });
});

describe("buildClosureInput", () => {
  test("labels speakers and skips empty turns", () => {
    const input = buildClosureInput([
      { role: "user", text: "  你好  " },
      { role: "assistant", text: "" },
      { role: "assistant", text: "在的" },
    ]);
    expect(input).toBe("用户: 你好\n\nmimi: 在的");
  });
});

describe("parseClosureResponse", () => {
  test("parses a bare JSON object", () => {
    const parsed = parseClosureResponse(
      '{"title":"调试","summary":"修好了构建","memories":["偏好 Bun"]}',
    );
    expect(parsed).toEqual({ title: "调试", summary: "修好了构建", memories: ["偏好 Bun"] });
  });

  test("recovers JSON wrapped in a code fence with prose around it", () => {
    const parsed = parseClosureResponse(
      '好的，这是结果：\n```json\n{"title":"T","summary":"S","memories":[]}\n```\n完毕',
    );
    expect(parsed).toEqual({ title: "T", summary: "S", memories: [] });
  });

  test("clamps memories to two and drops non-strings and blanks", () => {
    const parsed = parseClosureResponse(
      '{"title":"T","summary":"S","memories":["a"," ","b",3,"c"]}',
    );
    expect(parsed?.memories).toEqual(["a", "b"]);
  });

  test("returns null without a usable title and summary", () => {
    expect(parseClosureResponse("no json here")).toBeNull();
    expect(parseClosureResponse('{"title":"","summary":"S"}')).toBeNull();
    expect(parseClosureResponse('{"summary":"only summary"}')).toBeNull();
  });
});
