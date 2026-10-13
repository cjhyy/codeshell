import { describe, it, expect, mock } from "bun:test";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createProbeRunner, probeCli } from "./cc-capability.js";

function fakeProcess() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: mock((_signal: string) => true),
    unref: mock(() => {}),
  });
  const spawnProcess = mock(() => child) as unknown as typeof spawn;
  return { child, spawnProcess };
}

describe("probeCli", () => {
  it("reports available + version when the probe runner resolves a version", async () => {
    const r = await probeCli("claude", async () => ({
      ok: true,
      stdout: "2.1.186 (Claude Code)\n",
    }));
    expect(r.available).toBe(true);
    expect(r.version).toBe("2.1.186 (Claude Code)");
  });
  it("reports not-found when the runner throws ENOENT", async () => {
    const r = await probeCli("claude", async () => {
      const e: any = new Error("nope");
      e.code = "ENOENT";
      throw e;
    });
    expect(r.available).toBe(false);
    expect(r.reason).toBe("not-found");
  });
  it("reports not-executable on non-ENOENT failure", async () => {
    const r = await probeCli("claude", async () => ({ ok: false, stdout: "" }));
    expect(r.available).toBe(false);
    expect(r.reason).toBe("not-executable");
  });
});

describe("CLI version runner", () => {
  it("drains stderr and retains only a bounded stdout prefix", async () => {
    const { child, spawnProcess } = fakeProcess();
    const runner = createProbeRunner({ spawn: spawnProcess, timeoutMs: 10 });
    const pending = runner("fixture-cli");
    child.stderr.write(Buffer.alloc(128 * 1024, "e"));
    child.stdout.write(Buffer.alloc(128 * 1024, "v"));
    child.stdout.write("discarded trailing output");
    child.emit("close", 0);

    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("v".repeat(16 * 1024));
    expect(child.stderr.readableFlowing).toBe(true);
    expect(child.stderr.readableLength).toBe(0);
    await Bun.sleep(20);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("returns a bounded failure and cleans up even when the child never exits", async () => {
    const { child, spawnProcess } = fakeProcess();
    const runner = createProbeRunner({ spawn: spawnProcess, timeoutMs: 10 });
    const result = await probeCli("fixture-cli", runner);

    expect(result).toEqual({
      available: false,
      command: "fixture-cli",
      reason: "not-executable",
    });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(() => child.emit("error", new Error("late error"))).not.toThrow();
    child.emit("close", 0);
    expect(child.kill).toHaveBeenCalledTimes(1);
  }, 1_000);

  it("settles a timed-out probe even when termination throws", async () => {
    const { child, spawnProcess } = fakeProcess();
    child.kill.mockImplementation(() => {
      throw new Error("already gone");
    });
    const runner = createProbeRunner({ spawn: spawnProcess, timeoutMs: 10 });
    expect(await runner("fixture-cli")).toEqual({ ok: false, stdout: "" });
    expect(child.stdout.destroyed).toBe(true);
    expect(child.unref).toHaveBeenCalledTimes(1);
  }, 1_000);

  it("preserves not-found errors and clears the timeout after completion", async () => {
    const { child, spawnProcess } = fakeProcess();
    const runner = createProbeRunner({ spawn: spawnProcess, timeoutMs: 10 });
    const pending = probeCli("fixture-cli", runner);
    child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }));
    expect(await pending).toEqual({
      available: false,
      command: "fixture-cli",
      reason: "not-found",
    });
    const attempts = child.kill.mock.calls.length;
    await Bun.sleep(20);
    expect(child.kill).toHaveBeenCalledTimes(attempts);
  });

  it("shares concurrent probes for one CLI and permits a fresh attempt afterwards", async () => {
    const { child, spawnProcess } = fakeProcess();
    const runner = createProbeRunner({ spawn: spawnProcess });
    const first = runner("fixture-cli");
    const second = runner("fixture-cli");
    expect(first).toBe(second);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    child.stdout.write("fixture 1.0\n");
    child.emit("close", 0);
    expect(await first).toEqual({ ok: true, stdout: "fixture 1.0\n" });
    expect(await second).toEqual({ ok: true, stdout: "fixture 1.0\n" });

    const third = runner("fixture-cli");
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    child.emit("close", 0);
    expect(await third).toEqual({ ok: true, stdout: "" });
  });
});
