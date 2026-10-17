import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { stablePromptHash } from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/server/src/client-message-id.ts";

describe("actual server prompt fingerprint; no identity consumer or desktop import", () => {
  test("empty prompt has stable base36 hash and zero length suffix", () => {
    const value = stablePromptHash("");
    expect(value).toMatch(/^[0-9a-z]+-0$/);
    expect(stablePromptHash("")).toBe(value);
  });

  test("ordinary prompts remain deterministic and include UTF16 length", () => {
    for (const prompt of ["Explain this module", "请检查这段代码", "first line\nsecond line", "Review owned task."]) {
      const value = stablePromptHash(prompt);
      expect(value).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);
      expect(value.endsWith(`-${prompt.length.toString(36)}`)).toBe(true);
      expect(stablePromptHash(prompt)).toBe(value);
    }
  });

  test("complete Unicode strings use the existing UTF16 suffix convention", () => {
    for (const prompt of ["😀", "你好", "e\u0301"]) {
      expect(prompt.length).toBe(2);
      expect(stablePromptHash(prompt).endsWith("-2")).toBe(true);
    }
    expect(stablePromptHash("é").endsWith("-1")).toBe(true);
    expect(stablePromptHash("é")).not.toBe(stablePromptHash("e\u0301"));
  });

  test("hashing preserves caller whitespace rather than silently trimming", () => {
    expect(stablePromptHash(" task ")).not.toBe(stablePromptHash("task"));
    expect(stablePromptHash(" task ").endsWith("-6")).toBe(true);
    expect(stablePromptHash("\n task\r\n")).not.toBe(stablePromptHash("task"));
  });

  test("different line endings remain distinct caller strings", () => {
    expect(stablePromptHash("a\nb").endsWith("-3")).toBe(true);
    expect(stablePromptHash("a\r\nb").endsWith("-4")).toBe(true);
    expect(stablePromptHash("a\nb")).not.toBe(stablePromptHash("a\r\nb"));
  });

  test("ordinary multi-paragraph input remains deterministic", () => {
    const prompt = "请审查这个模块。\nExplain the current result.\n".repeat(1000);
    const value = stablePromptHash(prompt);
    expect(stablePromptHash(prompt)).toBe(value);
    expect(value.endsWith(`-${prompt.length.toString(36)}`)).toBe(true);
  });

  test("desktop counterpart source matches the server body without importing desktop", () => {
    const root = "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/";
    const server = readFileSync(`${root}packages/server/src/client-message-id.ts`, "utf8");
    const desktop = readFileSync(`${root}packages/desktop/src/renderer/app/appUtils.ts`, "utf8");
    const header = "export function stablePromptHash(text: string): string {";
    const start = desktop.indexOf(header);
    const finish = desktop.indexOf("\n}", start) + 2;
    expect(start).toBeGreaterThanOrEqual(0);
    expect(finish).toBeGreaterThan(start);
    expect(desktop.slice(start, finish).trim()).toBe(server.trim());
    // This is a static source-wiring assertion; no Desktop module is executed.
    expect(createHash("sha256").update(server.trim()).digest("hex")).toBe(
      createHash("sha256").update(desktop.slice(start, finish).trim()).digest("hex"),
    );
  });
});
