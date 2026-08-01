// AutoDream cadence counting must survive concurrent writers.
//
// `recordSession()` did an unlocked read → +1 → write on a state file shared by
// every host that sees the same CODE_SHELL_HOME (desktop worker, desktop
// main/automation, TUI, a standalone agent server). Releasing 48 real processes
// at once recorded 1–2 increments out of 48, so the "consolidate every N
// sessions" cadence drifted arbitrarily far out and auto-dream quietly stopped.
//
// Separately, `recordDreamComplete()` zeroed the counter. runDream() is async, so
// sessions finishing DURING a run were erased instead of counting toward the
// next cycle.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordDreamComplete, recordSession, sessionsSinceLastDream } from "./auto-dream.js";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cs-dream-cadence-"));
  prevHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

function stateCount(): number {
  const raw = readFileSync(join(home, "auto-dream-state.json"), "utf-8");
  return (JSON.parse(raw) as { sessionsSinceLastDream: number }).sessionsSinceLastDream;
}

describe("AutoDream cadence", () => {
  test("sequential increments accumulate", () => {
    recordSession();
    recordSession();
    recordSession();
    expect(sessionsSinceLastDream()).toBe(3);
  });

  test("completing a run keeps sessions that arrived while it was in flight", () => {
    recordSession();
    recordSession();
    // A dream run starts here and snapshots the counter…
    const consumed = sessionsSinceLastDream();
    expect(consumed).toBe(2);
    // …two more sessions finish while the (async) run is still going…
    recordSession();
    recordSession();
    // …and the run completes.
    recordDreamComplete(consumed);

    // The two mid-run sessions must carry over, not be zeroed away.
    expect(sessionsSinceLastDream()).toBe(2);
  });

  test("completing with no snapshot still resets (back-compat)", () => {
    recordSession();
    recordSession();
    recordDreamComplete();
    expect(sessionsSinceLastDream()).toBe(0);
  });

  test("the counter never goes negative", () => {
    recordSession();
    recordDreamComplete(50);
    expect(sessionsSinceLastDream()).toBe(0);
  });

  test("48 concurrent PROCESSES record all 48 increments", async () => {
    const total = 48;
    const script = `
      import { recordSession } from ${JSON.stringify(join(import.meta.dir, "auto-dream.ts"))};
      recordSession();
    `;
    const procs = Array.from({ length: total }, () =>
      Bun.spawn([process.execPath, "-e", script], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CODE_SHELL_HOME: home },
      }),
    );
    const codes = await Promise.all(procs.map((p) => p.exited));
    expect(codes.every((c) => c === 0)).toBe(true);
    // Pre-fix this landed at 1–2.
    expect(stateCount()).toBe(total);
  }, 120_000);
});
