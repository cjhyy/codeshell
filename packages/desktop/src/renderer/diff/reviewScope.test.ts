import { describe, expect, test } from "bun:test";
import { filterByScope, isStaged, isUnstaged } from "./reviewScope";
import type { GitStatusEntry } from "../../preload/types";

const e = (code: string, path: string): GitStatusEntry => ({ code, path });

// Representative porcelain v1 codes:
const staged = e("M ", "a.ts"); // modified, staged (X=M, Y=space)
const unstaged = e(" M", "b.ts"); // modified, unstaged (X=space, Y=M)
const both = e("MM", "c.ts"); // staged + further unstaged edits
const untracked = e("??", "d.ts"); // new file, unstaged
const stagedAdd = e("A ", "e.ts"); // newly added, staged

const all = [staged, unstaged, both, untracked, stagedAdd];

describe("isStaged / isUnstaged", () => {
  test("staged X-slot", () => {
    expect(isStaged(staged)).toBe(true);
    expect(isStaged(stagedAdd)).toBe(true);
    expect(isStaged(both)).toBe(true);
    expect(isStaged(unstaged)).toBe(false);
    expect(isStaged(untracked)).toBe(false); // ?? is not staged
  });
  test("unstaged Y-slot (untracked counts)", () => {
    expect(isUnstaged(unstaged)).toBe(true);
    expect(isUnstaged(untracked)).toBe(true);
    expect(isUnstaged(both)).toBe(true);
    expect(isUnstaged(staged)).toBe(false);
    expect(isUnstaged(stagedAdd)).toBe(false);
  });
});

describe("filterByScope", () => {
  test("all → everything", () => {
    expect(filterByScope(all, "all").length).toBe(5);
  });
  test("staged → only X-slot changes", () => {
    expect(filterByScope(all, "staged").map((x) => x.path)).toEqual(["a.ts", "c.ts", "e.ts"]);
  });
  test("unstaged → only Y-slot changes (incl untracked)", () => {
    expect(filterByScope(all, "unstaged").map((x) => x.path)).toEqual(["b.ts", "c.ts", "d.ts"]);
  });
  test("turn → only the caller's files (real status codes preserved)", () => {
    const out = filterByScope(all, "turn", ["a.ts", "d.ts"]);
    expect(out.map((x) => x.path)).toEqual(["a.ts", "d.ts"]);
  });
  test("turn with ./ and trailing-slash normalization", () => {
    const out = filterByScope([e(" M", "src/x.ts")], "turn", ["./src/x.ts"]);
    expect(out).toHaveLength(1);
  });
  test("turn with empty file set → falls back to all (don't show nothing)", () => {
    expect(filterByScope(all, "turn", []).length).toBe(5);
  });
});
