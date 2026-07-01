import { describe, expect, test } from "bun:test";
import { classifyBashLines, parsedArgs } from "./utils";
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
