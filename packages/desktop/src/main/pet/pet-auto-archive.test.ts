import { describe, expect, test } from "bun:test";
import { selectSessionsToArchive } from "./pet-auto-archive.js";

const DAY = 24 * 60 * 60 * 1000;

describe("selectSessionsToArchive", () => {
  const now = 10 * DAY;

  test("archives completed sessions idle for >= 7 days, skips the rest", () => {
    const ids = selectSessionsToArchive(
      [
        { engineSessionId: "old-done", status: "completed", updatedAt: now - 8 * DAY },
        { engineSessionId: "fresh-done", status: "completed", updatedAt: now - 2 * DAY },
        { engineSessionId: "old-active", status: "active", updatedAt: now - 8 * DAY },
        { engineSessionId: "old-failed", status: "failed", updatedAt: now - 8 * DAY },
        { engineSessionId: "already", status: "completed", updatedAt: now - 8 * DAY, archivedAt: 1 },
      ],
      { now, idleDays: 7 },
    );
    expect(ids).toEqual(["old-done"]);
  });

  test("treats the idle boundary as inclusive (exactly idleDays old archives)", () => {
    const ids = selectSessionsToArchive(
      [
        { engineSessionId: "boundary", status: "completed", updatedAt: now - 7 * DAY },
        { engineSessionId: "just-under", status: "completed", updatedAt: now - 7 * DAY + 1 },
      ],
      { now, idleDays: 7 },
    );
    expect(ids).toEqual(["boundary"]);
  });

  test("never archives sessions without a completed status", () => {
    const ids = selectSessionsToArchive(
      [
        { engineSessionId: "paused", status: "paused", updatedAt: now - 30 * DAY },
        { engineSessionId: "cancelled", status: "cancelled", updatedAt: now - 30 * DAY },
        { engineSessionId: "no-status", updatedAt: now - 30 * DAY },
      ],
      { now, idleDays: 7 },
    );
    expect(ids).toEqual([]);
  });
});
