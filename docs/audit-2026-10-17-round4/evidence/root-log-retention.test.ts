import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRecentLogs, rotateLogs, setLogsDir } from "../../../packages/core/src/logging/logger.ts";

// Independent retention review. Does not import or retry the skipped CLI fixture.
function dates(n: number): string[] {
  const today = new Date().toISOString().slice(0, 10);
  const midnight = Date.parse(today + "T00:00:00.000Z");
  return Array.from({ length: n }, (_, i) => new Date(midnight - (n - 1 - i) * 86400000).toISOString().slice(0, 10));
}

test("LOG-R4-01 rotation keeps seven oldest UI bucket files and erases today's existing engine events", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-r4-log-retention-"));
  const days = dates(7);
  try {
    setLogsDir(dir);
    for (const day of days) {
      for (const bucket of ["engine", "ui-ink"]) {
        writeFileSync(join(dir, `${bucket}-${day}.log`), JSON.stringify({ t: day + "T12:00:00Z", l: "info", msg: bucket + "-event" }) + "\n");
      }
    }
    expect(getRecentLogs()).toHaveLength(2);
    rotateLogs();
    const names = readdirSync(dir).sort();
    expect(names).toHaveLength(7);
    expect(names).toEqual(days.map((day) => `ui-ink-${day}.log`));
    expect(names).not.toContain(`engine-${days.at(-1)}.log`);
    expect(names).toContain(`ui-ink-${days[0]}.log`);
    expect(getRecentLogs().map((line) => JSON.parse(line).msg)).toEqual(["ui-ink-event"]);
  } finally { setLogsDir(null); rmSync(dir, { recursive: true, force: true }); }
});

test("single bucket rotation control does keep the newest seven dates", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-r4-log-retention-control-"));
  const days = dates(8);
  try {
    setLogsDir(dir);
    for (const day of days) writeFileSync(join(dir, `engine-${day}.log`), "owned audit log\n");
    rotateLogs();
    expect(readdirSync(dir).sort()).toEqual(days.slice(1).map((day) => `engine-${day}.log`));
  } finally { setLogsDir(null); rmSync(dir, { recursive: true, force: true }); }
});
