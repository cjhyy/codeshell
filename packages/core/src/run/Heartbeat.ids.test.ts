import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Heartbeat } from "./Heartbeat.js";

describe("Heartbeat run id path safety", () => {
  let runsDir: string;

  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), "cs-heartbeat-"));
  });

  afterEach(() => {
    rmSync(runsDir, { recursive: true, force: true });
  });

  test("rejects path-shaped run ids before composing heartbeat paths", () => {
    const heartbeat = new Heartbeat({ runsDir });

    expect(() => heartbeat.start("../escape")).toThrow(/invalid run id/);
    expect(() => heartbeat.read("a/b")).toThrow(/invalid run id/);
    expect(() => heartbeat.stop("/tmp/escape")).toThrow(/invalid run id/);
  });

  test("start is idempotent for a run id", async () => {
    mkdirSync(join(runsDir, "run-safe"));
    const heartbeat = new Heartbeat({ runsDir, intervalMs: 10 });

    heartbeat.start("run-safe");
    heartbeat.start("run-safe");
    heartbeat.stop("run-safe");
    await new Promise((resolve) => setTimeout(resolve, 35));

    expect(existsSync(join(runsDir, "run-safe", "heartbeat"))).toBe(false);
  });
});
