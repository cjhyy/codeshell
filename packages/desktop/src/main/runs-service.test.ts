import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deleteRunDir, getRun, listRuns } from "./runs-service";

describe("deleteRunDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-rs-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("removes a run directory", async () => {
    const rdir = path.join(dir, "run-1");
    fs.mkdirSync(rdir, { recursive: true });
    fs.writeFileSync(path.join(rdir, "run.json"), "{}");
    await deleteRunDir("run-1", dir);
    expect(fs.existsSync(rdir)).toBe(false);
  });

  it("is a no-op when missing", async () => {
    await deleteRunDir("ghost", dir);
    expect(true).toBe(true);
  });

  it("rejects path-shaped ids instead of deleting aliases", async () => {
    const victim = path.join(dir, "victim");
    fs.mkdirSync(victim, { recursive: true });
    const alias = path.join(dir, "run");
    fs.mkdirSync(alias, { recursive: true });
    await expect(deleteRunDir("r/un", dir)).rejects.toThrow(/invalid run id/);
    await expect(deleteRunDir("..", dir)).rejects.toThrow(/invalid run id/);
    expect(fs.existsSync(victim)).toBe(true);
    expect(fs.existsSync(alias)).toBe(true);
  });
});

describe("getRun", () => {
  it("rejects path-shaped and parent-dir ids instead of normalizing them", async () => {
    await expect(getRun("r/un")).rejects.toThrow(/invalid run id/);
    await expect(getRun("run..backup")).rejects.toThrow(/invalid run id/);
    await expect(getRun("a".repeat(129))).rejects.toThrow(/invalid run id/);
  });

  it("bounds events and ignores malformed event records", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-rs-detail-"));
    try {
      const runDir = path.join(dir, "run-1");
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(
        path.join(runDir, "run.json"),
        JSON.stringify({
          runId: "forged-id",
          objective: "review",
          cwd: "/tmp",
          status: "completed",
          createdAt: 1,
          updatedAt: 2,
        }),
      );
      const events = Array.from({ length: 250 }, (_, index) =>
        JSON.stringify({
          eventId: `e-${index}`,
          type: "progress",
          timestamp: index,
          data: { index },
        }),
      );
      events.splice(225, 0, JSON.stringify({ eventId: 7, type: "forged", data: {} }));
      fs.writeFileSync(path.join(runDir, "events.jsonl"), `${events.join("\n")}\n`);

      const detail = await getRun("run-1", dir);
      expect(detail?.runId).toBe("run-1");
      expect(detail?.events).toHaveLength(200);
      expect(detail?.events[0]?.eventId).toBe("e-50");
      expect(detail?.events.at(-1)?.eventId).toBe("e-249");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("listRuns", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-rs-list-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("isolates a corrupt snapshot instead of rejecting the whole history list", async () => {
    const healthy = path.join(dir, "healthy");
    const corrupt = path.join(dir, "corrupt");
    fs.mkdirSync(healthy, { recursive: true });
    fs.mkdirSync(corrupt, { recursive: true });
    fs.writeFileSync(
      path.join(healthy, "run.json"),
      JSON.stringify({
        runId: "healthy",
        objective: "still visible",
        cwd: "/tmp",
        status: "completed",
        createdAt: 1,
        updatedAt: 2,
      }),
    );
    fs.writeFileSync(path.join(corrupt, "run.json"), '{"runId":"corrupt"');

    expect((await listRuns(dir)).map((run) => run.runId)).toEqual(["healthy"]);
  });

  it("uses the directory id as authoritative instead of a forged snapshot id", async () => {
    const healthy = path.join(dir, "real-run");
    fs.mkdirSync(healthy, { recursive: true });
    fs.writeFileSync(
      path.join(healthy, "run.json"),
      JSON.stringify({
        runId: "different-run",
        objective: "safe",
        cwd: "/tmp",
        status: "completed",
        createdAt: 1,
        updatedAt: 2,
      }),
    );

    expect((await listRuns(dir))[0]?.runId).toBe("real-run");
  });

  it("skips oversized snapshots and symlinked run directories", async () => {
    const oversized = path.join(dir, "oversized");
    fs.mkdirSync(oversized, { recursive: true });
    fs.writeFileSync(path.join(oversized, "run.json"), "x".repeat(2 * 1024 * 1024 + 1));
    if (process.platform !== "win32") {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cs-rs-outside-"));
      try {
        fs.writeFileSync(path.join(outside, "run.json"), JSON.stringify({ runId: "linked" }));
        fs.symlinkSync(outside, path.join(dir, "linked"));
        expect(await listRuns(dir)).toEqual([]);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    } else {
      expect(await listRuns(dir)).toEqual([]);
    }
  });
});
