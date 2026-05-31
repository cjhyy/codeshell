import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunLock } from "./RunLock.js";

let runsDir: string;

/** Create a runs/<id>/run.json on disk so the lock target exists. */
function seedRun(id: string): void {
  const dir = join(runsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), JSON.stringify({ runId: id, status: "queued" }));
}

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), "runlock-"));
});
afterEach(() => rmSync(runsDir, { recursive: true, force: true }));

describe("RunLock.acquire", () => {
  test("acquires a lock when the run.json exists and is unlocked", async () => {
    const lock = new RunLock({ runsDir });
    seedRun("r1");

    const acquired = await lock.acquire("r1");

    expect(acquired).toEqual({ acquired: true });
    await lock.release("r1");
  });

  test("a second acquire on the same run is refused while held", async () => {
    const a = new RunLock({ runsDir });
    const b = new RunLock({ runsDir });
    seedRun("r2");

    expect(await a.acquire("r2")).toEqual({ acquired: true });
    expect(await b.acquire("r2")).toMatchObject({ acquired: false, reason: "locked" });

    await a.release("r2");
  });

  test("after release the lock can be re-acquired", async () => {
    const lock = new RunLock({ runsDir });
    seedRun("r3");

    expect(await lock.acquire("r3")).toEqual({ acquired: true });
    await lock.release("r3");
    expect(await lock.acquire("r3")).toEqual({ acquired: true });

    await lock.release("r3");
  });

  // Regression: submit()'s store.create() lands the run.json asynchronously,
  // but RunQueue drives executeRun()→acquire() on a microtask that can run
  // BEFORE that write completes. The old acquire() returned false the instant
  // the file was missing, which executeRun() reported as "already locked by
  // another worker" and silently abandoned the run (stuck in `queued`, no
  // Engine, no session — the "Run now does nothing" bug). A run.json that
  // shows up a moment later must NOT be mistaken for a held lock.
  test("acquires once the run.json appears shortly after (loses the create race)", async () => {
    const lock = new RunLock({ runsDir, targetWaitMs: 500, targetPollMs: 5 });
    // File does not exist yet at the moment we start acquiring.
    setTimeout(() => seedRun("r4"), 20);

    const acquired = await lock.acquire("r4");

    expect(acquired).toEqual({ acquired: true });
    await lock.release("r4");
  });

  test("reports missing_target when the run.json never appears", async () => {
    const lock = new RunLock({ runsDir, targetWaitMs: 20, targetPollMs: 5 });

    const acquired = await lock.acquire("missing");

    expect(acquired).toMatchObject({ acquired: false, reason: "missing_target" });
  });
});
