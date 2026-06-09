import { describe, expect, test } from "bun:test";
import { classifyBashLines } from "./utils";

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
