import { describe, it, expect } from "bun:test";
import {
  safeSpawn,
  safeSpawnShell,
  DEFAULT_MAX_OUTPUT_BYTES,
} from "../packages/core/src/runtime/safe-spawn.js";

// A6 — SafeSpawn unified subprocess lifecycle.
// These tests pin: happy path, pre-abort, mid-flight abort, timeout,
// byte caps, utf-8 boundary correctness, and listener cleanup.

const CWD = process.cwd();
const ENV = { ...process.env };

describe("A6 — safeSpawn happy path", () => {
  it("captures stdout, exit code, and sets no flags", async () => {
    const r = await safeSpawn("echo", ["hello"], { cwd: CWD, env: ENV, timeoutMs: 10_000 });
    expect(r.stdout).toContain("hello");
    expect(r.exitCode).toBe(0);
    expect(r.aborted).toBe(false);
    expect(r.timedOut).toBe(false);
    expect(r.stdoutTruncated).toBe(false);
    expect(r.stderrTruncated).toBe(false);
    expect(r.spawnFailed).toBe(false);
    expect(r.signal).toBeNull();
    expect(r.reason).toBe("ok");
  });

  it("captures stderr separately from stdout", async () => {
    const r = await safeSpawn(
      "node",
      ["-e", "process.stderr.write('oops'); process.stdout.write('ok')"],
      { cwd: CWD, env: ENV, timeoutMs: 10_000 },
    );
    expect(r.stdout).toBe("ok");
    expect(r.stderr).toBe("oops");
    expect(r.exitCode).toBe(0);
  });

  it("reports non-zero exit codes", async () => {
    const r = await safeSpawn(
      "node",
      ["-e", "process.exit(7)"],
      { cwd: CWD, env: ENV, timeoutMs: 10_000 },
    );
    expect(r.exitCode).toBe(7);
    expect(r.aborted).toBe(false);
    expect(r.timedOut).toBe(false);
    // Non-zero exit still counts as a clean lifecycle — reason is "ok".
    expect(r.reason).toBe("ok");
  });
});

describe("A6 — safeSpawn already-aborted", () => {
  it("returns immediately with aborted=true and does not spawn", async () => {
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    const r = await safeSpawn("sleep", ["10"], {
      cwd: CWD,
      env: ENV,
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    const elapsed = Date.now() - start;
    expect(r.aborted).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(elapsed).toBeLessThan(500);
    expect(r.reason).toBe("aborted");
  });
});

describe("A6 — safeSpawn mid-flight abort", () => {
  it("kills child via SIGTERM→SIGKILL cascade and returns aborted=true", async () => {
    const controller = new AbortController();
    const start = Date.now();
    const promise = safeSpawn("sleep", ["30"], {
      cwd: CWD,
      env: ENV,
      timeoutMs: 60_000,
      signal: controller.signal,
      ioDrainGraceMs: 100,
    });
    setTimeout(() => controller.abort(), 200);
    const r = await promise;
    const elapsed = Date.now() - start;
    expect(r.aborted).toBe(true);
    // Should resolve within abort + small margin (SIGTERM + 100ms grace + child reaping).
    expect(elapsed).toBeLessThan(3000);
    expect(r.reason).toBe("aborted");
  });
});

describe("A6 — safeSpawn timeout", () => {
  it("returns timedOut=true and kills the child", async () => {
    const start = Date.now();
    const r = await safeSpawn("sleep", ["30"], {
      cwd: CWD,
      env: ENV,
      timeoutMs: 200,
    });
    const elapsed = Date.now() - start;
    expect(r.timedOut).toBe(true);
    expect(r.aborted).toBe(false);
    // 200ms timeout + SIGTERM grace; well under the 30s sleep.
    expect(elapsed).toBeLessThan(5000);
    expect(r.reason).toBe("timeout");
  });

  // Regression: a fast-exiting direct child that leaves a grandchild holding
  // the inherited stdout pipe. Node's `close` waits for all stdio to close,
  // so the grandchild keeps the pipe open and `close` never fires — the
  // promise would hang forever past the timeout. The lifecycle must resolve
  // on timeout regardless. (Real-world: `bash -c "pytest"` where pytest
  // deadlocks in interpreter finalize.)
  it("resolves on timeout even when a grandchild holds the stdout pipe", async () => {
    const start = Date.now();
    const r = await safeSpawnShell("sleep 30 & echo started", {
      cwd: CWD,
      env: ENV,
      timeoutMs: 300,
    });
    const elapsed = Date.now() - start;
    expect(r.timedOut).toBe(true);
    // Must not hang: timeout(300) + SIGKILL grace(2s) + settle → well under 10s.
    expect(elapsed).toBeLessThan(10_000);
    expect(r.reason).toBe("timeout");
  });
});

describe("A6 — safeSpawn byte caps", () => {
  it("truncates stdout at maxOutputBytes and sets stdoutTruncated", async () => {
    const r = await safeSpawn(
      "node",
      ["-e", "process.stdout.write('a'.repeat(2_000_000))"],
      { cwd: CWD, env: ENV, timeoutMs: 10_000, maxOutputBytes: 1000 },
    );
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stdout.length).toBe(1000);
  });

  it("truncates stderr at maxOutputBytes and sets stderrTruncated", async () => {
    const r = await safeSpawn(
      "node",
      ["-e", "process.stderr.write('b'.repeat(2_000_000))"],
      { cwd: CWD, env: ENV, timeoutMs: 10_000, maxOutputBytes: 500 },
    );
    expect(r.stderrTruncated).toBe(true);
    expect(r.stderr.length).toBe(500);
  });

  it("defaults to DEFAULT_MAX_OUTPUT_BYTES when maxOutputBytes is omitted", async () => {
    const r = await safeSpawn(
      "node",
      ["-e", `process.stdout.write('x'.repeat(${DEFAULT_MAX_OUTPUT_BYTES + 1000}))`],
      { cwd: CWD, env: ENV, timeoutMs: 30_000 },
    );
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stdout.length).toBe(DEFAULT_MAX_OUTPUT_BYTES);
  });
});

describe("A6 — safeSpawn utf-8 correctness", () => {
  it("decodes multi-byte CJK characters without corruption", async () => {
    const r = await safeSpawn(
      "node",
      ["-e", "process.stdout.write('你好世界')"],
      { cwd: CWD, env: ENV, timeoutMs: 10_000 },
    );
    expect(r.stdout).toBe("你好世界");
  });
});

describe("A6 — safeSpawn listener cleanup", () => {
  it("does not accumulate listeners across many sequential calls", async () => {
    // If we leak on close, we'd see MaxListenersExceededWarning in console
    // and the listener count would grow. Bun's AbortSignal doesn't expose
    // an introspectable listener count, so we use behavioral check: 20
    // sequential happy calls must all complete normally and the signal
    // must still work on a 21st aborted call.
    const controller = new AbortController();
    for (let i = 0; i < 20; i++) {
      const r = await safeSpawn("echo", [`run-${i}`], {
        cwd: CWD,
        env: ENV,
        timeoutMs: 10_000,
        signal: controller.signal,
      });
      expect(r.exitCode).toBe(0);
      expect(r.aborted).toBe(false);
    }
    // Now abort and confirm a new spawn sees it.
    controller.abort();
    const r = await safeSpawn("sleep", ["10"], {
      cwd: CWD,
      env: ENV,
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    expect(r.aborted).toBe(true);
  });
});

describe("A6 — safeSpawn spawn failure", () => {
  it("reports spawnFailed=true when the binary does not exist", async () => {
    const r = await safeSpawn(
      "/no/such/binary-definitely-not-here",
      [],
      { cwd: CWD, env: ENV, timeoutMs: 5_000 },
    );
    expect(r.spawnFailed).toBe(true);
    expect(r.error).toBeDefined();
    expect(r.reason).toBe("spawn_failed");
  });
});

describe("A6 — safeSpawnShell", () => {
  it("runs a shell command through /bin/bash -c when no sandbox", async () => {
    const r = await safeSpawnShell("echo hello-shell && echo to-stderr 1>&2", {
      cwd: CWD,
      env: ENV,
      timeoutMs: 10_000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hello-shell");
    expect(r.stderr).toContain("to-stderr");
  });

  it("invokes the provided sandbox.wrap and calls cleanup on close", async () => {
    let wrapCalled = false;
    let cleanupCalled = false;
    const fakeBackend = {
      name: "off" as const,
      wrap(command: string, opts: { cwd: string; shell: string }) {
        wrapCalled = true;
        return {
          file: opts.shell,
          args: ["-c", command],
          cleanup: () => { cleanupCalled = true; },
        };
      },
    };
    const r = await safeSpawnShell("echo via-sandbox", {
      cwd: CWD,
      env: ENV,
      timeoutMs: 10_000,
      sandbox: fakeBackend,
    });
    expect(wrapCalled).toBe(true);
    expect(cleanupCalled).toBe(true);
    expect(r.stdout).toContain("via-sandbox");
  });

  it("calls sandbox cleanup even on pre-spawn abort", async () => {
    let cleanupCalled = false;
    const fakeBackend = {
      name: "off" as const,
      wrap(command: string, opts: { cwd: string; shell: string }) {
        return {
          file: opts.shell,
          args: ["-c", command],
          cleanup: () => { cleanupCalled = true; },
        };
      },
    };
    const controller = new AbortController();
    controller.abort();
    const r = await safeSpawnShell("echo never", {
      cwd: CWD,
      env: ENV,
      timeoutMs: 10_000,
      sandbox: fakeBackend,
      signal: controller.signal,
    });
    expect(r.aborted).toBe(true);
    expect(cleanupCalled).toBe(true);
  });
});
