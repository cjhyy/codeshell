import { describe, expect, test } from "bun:test";
import { latestUndoTarget, earliestSnapshotsPerFile } from "./undo-target.js";
import type { FileSnapshot } from "./file-history.js";

const snap = (filePath: string, timestamp: number): FileSnapshot => ({
  filePath,
  timestamp,
  backupPath: `/backups/${filePath}.${timestamp}`,
  hash: `${filePath}-${timestamp}`,
  size: 1,
});

describe("latestUndoTarget", () => {
  test("empty history → null", () => {
    expect(latestUndoTarget([])).toBeNull();
  });

  test("single snapshot → itself", () => {
    const s = snap("a.ts", 100);
    expect(latestUndoTarget([s])).toBe(s);
  });

  test("picks the greatest timestamp regardless of array order", () => {
    const a = snap("a.ts", 100);
    const b = snap("b.ts", 300);
    const c = snap("c.ts", 200);
    expect(latestUndoTarget([a, b, c])).toBe(b);
  });

  test("same-millisecond tie → last entry in array order wins", () => {
    const first = snap("a.ts", 500);
    const second = snap("b.ts", 500);
    expect(latestUndoTarget([first, second])).toBe(second);
  });
});

describe("earliestSnapshotsPerFile", () => {
  test("empty → []", () => {
    expect(earliestSnapshotsPerFile([])).toEqual([]);
  });

  test("one snapshot per file, earliest of each", () => {
    const a1 = snap("a.ts", 100);
    const a2 = snap("a.ts", 300); // later edit of a — should NOT be picked
    const b1 = snap("b.ts", 200);
    const out = earliestSnapshotsPerFile([a1, a2, b1]);
    expect(out).toHaveLength(2);
    expect(out.find((s) => s.filePath === "a.ts")).toBe(a1);
    expect(out.find((s) => s.filePath === "b.ts")).toBe(b1);
  });

  test("ordered by each file's first-edit time, oldest first", () => {
    const out = earliestSnapshotsPerFile([
      snap("b.ts", 300),
      snap("a.ts", 100),
      snap("c.ts", 200),
    ]);
    expect(out.map((s) => s.filePath)).toEqual(["a.ts", "c.ts", "b.ts"]);
  });

  test("same-ms tie for one file → first array entry wins", () => {
    const first = snap("a.ts", 500);
    first.hash = "FIRST";
    const second = snap("a.ts", 500);
    second.hash = "SECOND";
    const out = earliestSnapshotsPerFile([first, second]);
    expect(out).toHaveLength(1);
    expect(out[0]!.hash).toBe("FIRST");
  });
});
