import { describe, expect, test } from "bun:test";
import { classifyBashLines, type BashLineKind } from "./bash-output-style.js";

/** Convenience: classify a whole body and return just the kinds, line-by-line. */
function kinds(body: string): BashLineKind[] {
  return classifyBashLines(body.split("\n")).map((c) => c.kind);
}

describe("classifyBashLines", () => {
  test("plain stdout stays normal", () => {
    expect(kinds("hello\nworld")).toEqual(["normal", "normal"]);
  });

  test("Exit code status line is marked error, body stays normal", () => {
    const body = "Exit code: 1 (command failed)\nsome stdout\nmore stdout";
    expect(kinds(body)).toEqual(["error", "normal", "normal"]);
  });

  test("Killed-by-signal status line is marked error", () => {
    expect(kinds("Killed by signal: SIGKILL\noutput")).toEqual(["error", "normal"]);
  });

  test("STDERR marker and everything after it is error", () => {
    const body = "stdout line\nSTDERR:\nerr line 1\nerr line 2";
    expect(kinds(body)).toEqual(["normal", "error", "error", "error"]);
  });

  test("status line + stdout + STDERR section together", () => {
    const body = ["Exit code: 2 (command failed)", "ok output", "STDERR:", "boom"].join("\n");
    expect(kinds(body)).toEqual(["error", "normal", "error", "error"]);
  });

  test("a literal 'STDERR:' substring mid-line does not trigger the region", () => {
    // Only a line that IS exactly the STDERR: marker flips the region; an
    // arbitrary log line that merely contains the word must not.
    expect(kinds("echo STDERR: not a marker\nstill stdout")).toEqual(["normal", "normal"]);
  });

  test("preserves original text verbatim (copy fidelity)", () => {
    const lines = ["Exit code: 1 (command failed)", "  indented  ", "STDERR:", "\ttabbed"];
    const out = classifyBashLines(lines);
    expect(out.map((c) => c.text)).toEqual(lines);
  });

  test("Exit code line appearing AFTER the STDERR region still classifies as error", () => {
    // Defensive: order shouldn't matter for marking, region is sticky once entered.
    expect(kinds("STDERR:\nerr\nExit code: 1 (command failed)")).toEqual([
      "error",
      "error",
      "error",
    ]);
  });
});
