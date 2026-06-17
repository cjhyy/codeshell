import { describe, it, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { readSettings } from "./settings-service.js";

/**
 * Cross-process lost-update test (the "局限" this work closes).
 *
 * The in-process writeChains can't be exercised across processes — a real proof
 * needs SEPARATE OS processes doing read-modify-write on the SAME settings.json
 * at once. Each spawned worker writes its own key N times. Without the
 * cross-process file lock, interleaved RMW would drop some workers' keys
 * (last-writer-wins on a stale read). With the lock, every key must survive.
 */

const WORKER = join(import.meta.dir, "settings-write-worker.fixture.ts");

function runWorker(cwd: string, key: string, iterations: number): Promise<number> {
  return new Promise((resolve, reject) => {
    // Run the TS fixture with the same bun runtime executing this test.
    const proc = spawn(process.execPath, [WORKER, cwd, key, String(iterations)], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    proc.on("error", reject);
    proc.on("exit", (code) => resolve(code ?? -1));
  });
}

describe("settings-service cross-process locking", () => {
  it("does not lose updates when several processes write concurrently", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "settings-xproc-"));
    try {
      const keys = ["a", "b", "c", "d", "e"];
      const ITER = 8;
      const codes = await Promise.all(keys.map((k) => runWorker(cwd, k, ITER)));
      // Every worker exited cleanly.
      expect(codes.every((c) => c === 0)).toBe(true);

      const result = (await readSettings("project", cwd)) ?? {};
      // Every key survived (none dropped by a racing RMW) and holds its last
      // written value (ITER-1). A lost update would leave a key missing.
      for (const k of keys) {
        expect(result[k]).toBe(ITER - 1);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});
