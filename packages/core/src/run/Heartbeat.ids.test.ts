import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

  test("rejects forged or mismatched heartbeat fields", () => {
    const runDir = join(runsDir, "run-safe");
    mkdirSync(runDir);
    const heartbeat = new Heartbeat({ runsDir });
    writeFileSync(
      join(runDir, "heartbeat"),
      JSON.stringify({ pid: process.pid, timestamp: Date.now(), runId: "another-run" }),
    );
    expect(heartbeat.read("run-safe")).toBeNull();

    writeFileSync(
      join(runDir, "heartbeat"),
      JSON.stringify({ pid: -1, timestamp: Number.POSITIVE_INFINITY, runId: "run-safe" }),
    );
    expect(heartbeat.read("run-safe")).toBeNull();
  });

  test("never follows linked run directories or heartbeat files", () => {
    const outside = mkdtempSync(join(tmpdir(), "cs-heartbeat-outside-"));
    try {
      const outsideHeartbeat = join(outside, "heartbeat");
      writeFileSync(outsideHeartbeat, "keep");
      symlinkSync(outside, join(runsDir, "run-linked"));
      const heartbeat = new Heartbeat({ runsDir });
      heartbeat.start("run-linked");
      expect(heartbeat.read("run-linked")).toBeNull();
      heartbeat.stop("run-linked");
      expect(readFileSync(outsideHeartbeat, "utf8")).toBe("keep");

      mkdirSync(join(runsDir, "run-file-link"));
      symlinkSync(outsideHeartbeat, join(runsDir, "run-file-link", "heartbeat"));
      heartbeat.start("run-file-link");
      heartbeat.stop("run-file-link");
      expect(readFileSync(outsideHeartbeat, "utf8")).toBe("keep");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
