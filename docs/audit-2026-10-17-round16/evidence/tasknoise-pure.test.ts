import { describe, test, expect } from "bun:test";
import { detectPastedNoise } from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/utils/task-sanitizer.ts";

// Characterization of current behavior. These assertions do not claim fixes,
// execute Engine, render terminals, or establish a clipboard transport contract.
describe("round16 task-noise pure helper", () => {
  test("ordinary long prose remains task text", () => {
    const task = "Please explain why this build reports a failing assertion.";
    expect(detectPastedNoise(task)).toEqual({ isNoise: false, reason: "ok", cleaned: task });
  });
  test("under ten code units bypasses even box-only input", () => {
    const task = "─".repeat(9);
    expect(detectPastedNoise(task)).toEqual({ isNoise: false, reason: "short", cleaned: task });
  });
  test("ten box glyphs are rejected as entirely stripped input", () => {
    expect(detectPastedNoise("─".repeat(10))).toEqual({ isNoise: true, reason: "all ANSI/box chars", cleaned: "" });
  });
  test("nonempty low-signal text at original length 100 remains accepted", () => {
    const task = "A".repeat(10) + "─".repeat(90);
    expect(task.length).toBe(100);
    expect(detectPastedNoise(task).isNoise).toBe(false);
  });
  test("same signal at original length 101 crosses threshold", () => {
    const task = "A".repeat(10) + "─".repeat(91);
    expect(task.length).toBe(101);
    expect(detectPastedNoise(task).isNoise).toBe(true);
  });
  test("exactly 30 percent signal remains accepted", () => {
    const task = "A".repeat(33) + "─".repeat(77);
    expect(detectPastedNoise(task).isNoise).toBe(false);
    expect(detectPastedNoise(task).cleaned).toBe("A".repeat(33));
  });
  test("below 30 percent signal is rejected", () => {
    const task = "A".repeat(32) + "─".repeat(78);
    expect(detectPastedNoise(task).isNoise).toBe(true);
    expect(detectPastedNoise(task).cleaned).toBe("A".repeat(32));
  });
  test("basic SGR-only stream is recognized once above the short gate", () => {
    expect(detectPastedNoise("\x1b[31m\x1b[0m".repeat(2))).toEqual({ isNoise: true, reason: "all ANSI/box chars", cleaned: "" });
  });
  test("semicolon true-color SGR-only stream is recognized", () => {
    expect(detectPastedNoise("\x1b[38;2;1;2;3m".repeat(10)).isNoise).toBe(true);
  });
  test("colon true-color SGR-only stream is retained as signal", () => {
    const task = "\x1b[38:2::1:2:3m".repeat(10);
    expect(detectPastedNoise(task)).toEqual({ isNoise: false, reason: "ok", cleaned: task });
  });
  test("OSC8-only stream is retained as signal", () => {
    const task = "\x1b]8;;https://example.invalid/owned\x07\x1b]8;;\x07".repeat(3);
    expect(detectPastedNoise(task)).toEqual({ isNoise: false, reason: "ok", cleaned: task });
  });
  test("custom dashed border glyphs remain signal", () => {
    expect(detectPastedNoise("╌".repeat(140))).toEqual({ isNoise: false, reason: "ok", cleaned: "╌".repeat(140) });
    expect(detectPastedNoise("╎".repeat(140)).isNoise).toBe(false);
  });
  test("equivalent solid border glyphs are entirely stripped", () => {
    expect(detectPastedNoise("─".repeat(140)).isNoise).toBe(true);
    expect(detectPastedNoise("│".repeat(140)).isNoise).toBe(true);
  });
  test("ordinary prose decorated by ANSI has only its cleaned projection changed", () => {
    const prose = "Explain this failing assertion please.";
    const task = "\x1b[31m" + prose + "\x1b[0m";
    expect(detectPastedNoise(task)).toEqual({ isNoise: false, reason: "ok", cleaned: prose });
    expect(task).toBe("\x1b[31m" + prose + "\x1b[0m");
  });
  test("CR-only creates one LF in the helper projection", () => {
    const task = "Explain line A\rthen line B";
    expect(detectPastedNoise(task).cleaned).toBe("Explain line A\nthen line B");
    expect(detectPastedNoise(task).isNoise).toBe(false);
  });
  test("CRLF creates two LF in helper projection without changing input", () => {
    const task = "Explain line A\r\nthen line B";
    expect(detectPastedNoise(task).cleaned).toBe("Explain line A\n\nthen line B");
    expect(task).toBe("Explain line A\r\nthen line B");
  });
  test("explicit question plus dense recognized decoration triggers heuristic", () => {
    const task = "请解释以下终端输出：\n" + "─".repeat(140) + "\nFAIL";
    const result = detectPastedNoise(task);
    expect(result.isNoise).toBe(true);
    expect(result.cleaned).toBe("请解释以下终端输出：\n\nFAIL");
  });
});
