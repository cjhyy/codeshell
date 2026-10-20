import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateLogs, setLogsDir } from "./logger.js";

function lastDays(n: number): string[] {
  const midnight = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
  return Array.from({ length: n }, (_, i) =>
    new Date(midnight - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
}

let dir: string | undefined;
afterEach(() => {
  setLogsDir(null);
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("rotateLogs", () => {
  it("keeps the newest days of every bucket instead of trimming by file-name prefix", () => {
    dir = mkdtempSync(join(tmpdir(), "cs-log-rotation-"));
    setLogsDir(dir);
    const days = lastDays(9);
    for (const day of days) {
      writeFileSync(join(dir, `engine-${day}.log`), "e\n");
      writeFileSync(join(dir, `ui-ink-${day}.log`), "u\n");
    }

    rotateLogs();

    const kept = days.slice(-7);
    expect(readdirSync(dir).sort()).toEqual(
      [...kept.map((d) => `engine-${d}.log`), ...kept.map((d) => `ui-ink-${d}.log`)].sort(),
    );
  });
});
