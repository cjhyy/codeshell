import { describe, expect, test } from "bun:test";
import { latestUndoTarget } from "./undo-target.js";
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
