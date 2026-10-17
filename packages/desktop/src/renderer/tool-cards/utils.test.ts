import { describe, expect, test } from "bun:test";
import { classifyBashLines, parsedArgs, truncate } from "./utils";
import type { ToolMessage } from "../types";

function toolMsg(partial: Partial<ToolMessage>): ToolMessage {
  return {
    kind: "tool",
    id: "t1",
    toolName: "DriveAgent",
    args: "{}",
    ...partial,
  } as ToolMessage;
}

describe("truncate Unicode summaries", () => {
  test.each([70, 80, 90])("does not split a surrogate pair at the real %i-unit limit", (max) => {
    const input = "x".repeat(max - 2) + "😀tail";
    const output = truncate(input, max);
    expect(output).toBe("x".repeat(max - 2) + "…");
    expect(output.isWellFormed()).toBe(true);
    expect(output.length).toBeLessThanOrEqual(max);
    expect(new TextDecoder().decode(new TextEncoder().encode(output))).toBe(output);
  });

  test("retains complete supplementary characters at and before the boundary", () => {
    expect(truncate("x".repeat(67) + "😀tail", 70)).toBe("x".repeat(67) + "😀…");
    expect(truncate("x".repeat(68) + "😀", 70)).toBe("x".repeat(68) + "😀");
    expect(truncate("😀短文本", 70)).toBe("😀短文本");
  });

  test("keeps the existing ASCII and BMP text budgets", () => {
    expect(truncate("abcdef", 5)).toBe("abcd…");
    expect(truncate("中文摘要文本", 5)).toBe("中文摘要…");
    expect(truncate("abcd", 5)).toBe("abcd");
    expect(truncate("", 70)).toBe("");
  });
});

/**
 * parsedArgs is the single source the tool cards must read for args — it prefers
 * argsLive (streamed via tool_use_args_delta) over the raw message.args snapshot
 * (which is "{}" at tool_use_start). GenericToolCard used to read raw args and so
 * showed "{}" for DriveAgent etc. while streaming (TODO-background-panel #4).
 */
describe("parsedArgs", () => {
  test("prefers argsLive over the empty tool_use_start snapshot (live view)", () => {
    const m = toolMsg({ args: "{}", argsLive: { cli: "codex", prompt: "go" } });
    expect(parsedArgs(m)).toEqual({ cli: "codex", prompt: "go" });
  });

  test("falls back to parsing message.args when no argsLive (replay)", () => {
    const m = toolMsg({ args: JSON.stringify({ cli: "claude", cwd: "/x" }) });
    expect(parsedArgs(m)).toEqual({ cli: "claude", cwd: "/x" });
  });

  test("returns {} for an unparseable args string", () => {
    expect(parsedArgs(toolMsg({ args: "not json" }))).toEqual({});
  });
});

/** Mirrors core's bash-output-style.test.ts; guards the duplicated copy. */
describe("classifyBashLines (desktop copy)", () => {
  test("plain stdout is not error", () => {
    expect(classifyBashLines(["a", "b"]).map((c) => c.isError)).toEqual([false, false]);
  });

  test("Exit code status line is error, body normal", () => {
    const out = classifyBashLines(["Exit code: 1 (command failed)", "out"]);
    expect(out.map((c) => c.isError)).toEqual([true, false]);
  });

  test("Killed-by-signal line is error", () => {
    expect(classifyBashLines(["Killed by signal: SIGKILL"]).map((c) => c.isError)).toEqual([true]);
  });

  test("STDERR marker starts a sticky error region", () => {
    const out = classifyBashLines(["stdout", "STDERR:", "e1", "e2"]);
    expect(out.map((c) => c.isError)).toEqual([false, true, true, true]);
  });

  test("a line merely containing STDERR: is not a marker", () => {
    expect(classifyBashLines(["echo STDERR: x", "y"]).map((c) => c.isError)).toEqual([
      false,
      false,
    ]);
  });

  test("text is preserved verbatim", () => {
    const lines = ["Exit code: 2 (command failed)", "  spaced  ", "STDERR:", "\ttab"];
    expect(classifyBashLines(lines).map((c) => c.text)).toEqual(lines);
  });
});
