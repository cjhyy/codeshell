import { expect, test } from "bun:test";
import {
  earliestSnapshotsPerFile,
  latestUndoTarget,
  latestTurnUndoTargets,
  latestRedoTargets,
} from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/session/undo-target.ts";

const snapshot = (filePath: string, timestamp: number, turnSeq?: number, undone = false) =>
  Object.freeze({ filePath, timestamp, turnSeq, undone, backupPath: `owned:${filePath}`, hash: "owned", size: 1 });
const redo = (filePath: string, turnSeq: number) =>
  Object.freeze({ filePath, turnSeq, backupPath: `owned:${filePath}`, existedBefore: true });

test("owned frozen snapshots retain turn precedence across clock reversal and undone rows", () => {
  const prior = snapshot("older.txt", 900, 2);
  const live = snapshot("current.txt", 100, 3);
  const laterSameFile = snapshot("current.txt", 120, 3);
  const undone = snapshot("undone.txt", 950, 4, true);
  const source = Object.freeze([prior, laterSameFile, undone, live]);
  const before = JSON.stringify(source);
  const result = latestTurnUndoTargets(source as any);
  expect(result).toEqual([live]);
  expect(result[0]).toBe(live);
  expect(JSON.stringify(source)).toBe(before);
});

test("owned three pending redo turns select the lowest turn independently of record order", () => {
  const first = redo("first.txt", 1);
  const second = redo("second.txt", 2);
  const third = redo("third.txt", 3);
  const records = Object.freeze([third, first, second]);
  const before = JSON.stringify(records);
  expect(latestRedoTargets(records as any, [snapshot("prior.txt", 50, 0)])).toEqual([first]);
  expect(latestRedoTargets(records as any, [snapshot("new.txt", 60, 4)])).toEqual([]);
  expect(JSON.stringify(records)).toBe(before);
});

test("owned whole-session Unicode and spaced path labels remain distinct with stable tied baselines", () => {
  const first = snapshot("笔记 draft.txt", 100, 1);
  const tied = snapshot("笔记 draft.txt", 100, 2);
  const distinct = snapshot("笔记.txt", 101, 1);
  const source = Object.freeze([first, tied, distinct, snapshot("gone.txt", 10, 3, true)]);
  const before = JSON.stringify(source);
  expect(earliestSnapshotsPerFile(source as any)).toEqual([first, distinct]);
  expect(earliestSnapshotsPerFile(source as any)[0]).toBe(first);
  expect(JSON.stringify(source)).toBe(before);
});

test("legacy single-modification selector accepts finite timestamps before the Unix epoch", () => {
  const oldest = snapshot("old.txt", -300);
  const newer = snapshot("new.txt", -100);
  expect(latestUndoTarget([newer, oldest])).toBe(newer);
  expect(latestUndoTarget([])).toBeNull();
});
