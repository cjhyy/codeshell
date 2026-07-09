import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { TunnelManager } from "./tunnel-manager.js";

/**
 * A fake child process good enough for TunnelManager: stdout/stderr are
 * EventEmitters, and `kill` records the call. We push lines through the
 * relevant stream to drive the manager.
 */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  killSignal?: string;
  /** Every signal delivered, in order (proves SIGTERM→SIGKILL escalation). */
  signals: string[] = [];
  /** When false, kill() does NOT auto-exit — the test drives exit via
   *  exitNow(), proving start() truly waits for the old process to die. */
  autoExit: boolean;
  constructor(opts: { autoExit?: boolean } = {}) {
    super();
    this.autoExit = opts.autoExit ?? true;
  }
  kill(signal?: string): boolean {
    this.killed = true;
    this.killSignal = signal;
    this.signals.push(signal ?? "SIGTERM");
    if (this.autoExit) {
      queueMicrotask(() => this.emit("exit", null, signal ?? "SIGTERM"));
    }
    return true;
  }
  /** Manually emulate the OS reporting the process exit. */
  exitNow(signal: string = "SIGTERM"): void {
    this.emit("exit", null, signal);
  }
}

function makeManager(
  child: FakeChild,
  timeoutMs = 50,
  opts: { ready?: boolean; spawnArgs?: string[][] } = {},
) {
  const ready = opts.ready ?? true;
  return new TunnelManager({
    binaryPath: () => "/fake/cloudflared",
    spawn: (_cmd, args) => {
      opts.spawnArgs?.push(args);
      return child as unknown as import("node:child_process").ChildProcess;
    },
    timeoutMs,
    // Deterministic readiness: tests opt into ready=false to exercise the
    // "registered but edge connection never readies" failure (the real 1033).
    checkReady: async () => ready,
    readyTimeoutMs: 60,
    readyIntervalMs: 5,
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 200,
  intervalMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("timed out waiting for condition");
}

describe("TunnelManager", () => {
  test("extracts the trycloudflare URL from stderr and resolves", async () => {
    const child = new FakeChild();
    const mgr = makeManager(child);
    const promise = mgr.start(12345);
    child.stderr.emit(
      "data",
      Buffer.from("2026-01-01 INF |  https://foo-bar-baz.trycloudflare.com  |\n"),
    );
    const res = await promise;
    expect(res.url).toBe("https://foo-bar-baz.trycloudflare.com");
  });

  test("spawns with --protocol http2 (QUIC is blocked on many networks → 1033)", async () => {
    const child = new FakeChild();
    const spawnArgs: string[][] = [];
    const mgr = makeManager(child, 50, { spawnArgs });
    const promise = mgr.start(12345);
    child.stderr.emit("data", Buffer.from("https://a-b.trycloudflare.com\n"));
    await promise;
    expect(spawnArgs[0]).toContain("--protocol");
    expect(spawnArgs[0]).toContain("http2");
    // a fixed metrics endpoint must be passed so we can poll /ready
    expect(spawnArgs[0]).toContain("--metrics");
  });

  test("does NOT report connected until the edge connection is ready", async () => {
    const child = new FakeChild();
    // URL appears but /ready never returns ready → must reject + kill, not
    // hand back a dead QR that yields error 1033 on the phone.
    const mgr = makeManager(child, 200, { ready: false });
    const statuses: string[] = [];
    mgr.on("status", (s: string) => statuses.push(s));
    const promise = mgr.start(12345);
    child.stderr.emit("data", Buffer.from("https://dead-tunnel.trycloudflare.com\n"));
    await expect(promise).rejects.toThrow(/就绪|ready|注册|1033/i);
    expect(statuses).not.toContain("connected");
    expect(child.killed).toBe(true);
  });

  test("extracts URL from stdout too", async () => {
    const child = new FakeChild();
    const mgr = makeManager(child);
    const promise = mgr.start(12345);
    child.stdout.emit("data", Buffer.from("here is https://abc-def.trycloudflare.com now\n"));
    const res = await promise;
    expect(res.url).toBe("https://abc-def.trycloudflare.com");
  });

  test("times out and kills the child when no URL appears", async () => {
    const child = new FakeChild();
    const mgr = makeManager(child, 20);
    await expect(mgr.start(12345)).rejects.toThrow(/隧道|超时|timeout/i);
    expect(child.killed).toBe(true);
  });

  test("emits disconnected when the child exits after connecting", async () => {
    const child = new FakeChild();
    const mgr = makeManager(child);
    const statuses: string[] = [];
    mgr.on("status", (s: string) => statuses.push(s));
    const promise = mgr.start(12345);
    child.stderr.emit("data", Buffer.from("https://x-y.trycloudflare.com\n"));
    await promise;
    expect(statuses).toContain("connected");
    // an unsolicited exit (crash) → disconnected
    child.emit("exit", 1, null);
    expect(statuses).toContain("disconnected");
  });

  test("emits disconnected when runtime readiness is lost, then connected when it recovers", async () => {
    const child = new FakeChild();
    let ready = true;
    const mgr = new TunnelManager({
      binaryPath: () => "/fake/cloudflared",
      spawn: () => child as unknown as import("node:child_process").ChildProcess,
      timeoutMs: 50,
      checkReady: async () => ready,
      readyTimeoutMs: 60,
      readyIntervalMs: 5,
      healthCheckIntervalMs: 5,
      healthFailureThreshold: 2,
    });
    const statuses: string[] = [];
    mgr.on("status", (s: string) => statuses.push(s));

    const promise = mgr.start(12345);
    child.stderr.emit("data", Buffer.from("https://steady-tunnel.trycloudflare.com\n"));
    await promise;
    expect(mgr.isConnected()).toBe(true);

    ready = false;
    await waitFor(() => statuses.includes("disconnected"));
    expect(mgr.isConnected()).toBe(false);

    ready = true;
    await waitFor(() => statuses.filter((s) => s === "connected").length >= 2);
    expect(mgr.isConnected()).toBe(true);

    mgr.stop();
  });

  test("stop kills the child and suppresses the disconnected event", async () => {
    const child = new FakeChild();
    const mgr = makeManager(child);
    const statuses: string[] = [];
    mgr.on("status", (s: string) => statuses.push(s));
    const promise = mgr.start(12345);
    child.stderr.emit("data", Buffer.from("https://x-y.trycloudflare.com\n"));
    await promise;
    mgr.stop();
    expect(child.killed).toBe(true);
    // wait a tick for the exit emitted by kill()
    await new Promise((r) => setTimeout(r, 5));
    // no disconnected after an intentional stop
    expect(statuses).not.toContain("disconnected");
  });

  test("restart after a soft disconnect waits for the stale child to exit before re-spawning", async () => {
    // Soft disconnect (edge /ready lost) keeps the cloudflared child ALIVE so it
    // can auto-recover. Re-opening must tear the stale child down AND wait for it
    // to actually exit (freeing the fixed metrics port) before spawning — else
    // the new cloudflared can't bind 20741 and exits code=1 (the app-restart bug).
    const first = new FakeChild({ autoExit: false }); // we drive its exit manually
    let ready = true;
    let current: FakeChild = first;
    const spawnArgs: string[][] = [];
    const mgr = new TunnelManager({
      binaryPath: () => "/fake/cloudflared",
      spawn: (_cmd, args) => {
        spawnArgs.push(args);
        return current as unknown as import("node:child_process").ChildProcess;
      },
      timeoutMs: 50,
      checkReady: async () => ready,
      readyTimeoutMs: 60,
      readyIntervalMs: 5,
      healthCheckIntervalMs: 5,
      healthFailureThreshold: 2,
      killGraceMs: 1_000,
      killHardTimeoutMs: 2_000,
    });

    const p1 = mgr.start(12345);
    first.stderr.emit("data", Buffer.from("https://old-tunnel.trycloudflare.com\n"));
    await p1;

    // Soft disconnect: readiness lost, but the child is intentionally kept alive.
    ready = false;
    await waitFor(() => !mgr.isConnected());
    expect(first.killed).toBe(false); // still alive — recover-in-place path

    // Re-open. start() must SIGTERM the stale child but NOT spawn the new one
    // until that child has actually exited.
    ready = true;
    const second = new FakeChild();
    current = second;
    const p2 = mgr.start(12345);
    await waitFor(() => first.killed); // stale child got SIGTERM
    await new Promise((r) => setTimeout(r, 20));
    expect(spawnArgs.length).toBe(1); // still ONE — new spawn is blocked on exit

    first.exitNow(); // now the old process finally dies, releasing the port
    await waitFor(() => spawnArgs.length === 2); // only now do we re-spawn
    second.stderr.emit("data", Buffer.from("https://new-tunnel.trycloudflare.com\n"));
    const res = await p2;
    expect(res.url).toBe("https://new-tunnel.trycloudflare.com");
    expect(mgr.isConnected()).toBe(true);

    void mgr.stop();
  });

  test("stop() then immediate start() waits for the old child before re-spawning", async () => {
    // stop() clears this.child synchronously; the old process is still dying.
    // A start() right after must await stop()'s teardown so it doesn't spawn
    // into the still-held metrics port.
    const first = new FakeChild({ autoExit: false });
    let current: FakeChild = first;
    const spawnArgs: string[][] = [];
    const mgr = new TunnelManager({
      binaryPath: () => "/fake/cloudflared",
      spawn: (_cmd, args) => {
        spawnArgs.push(args);
        return current as unknown as import("node:child_process").ChildProcess;
      },
      timeoutMs: 50,
      checkReady: async () => true,
      readyTimeoutMs: 60,
      readyIntervalMs: 5,
      healthCheckIntervalMs: 0,
      killGraceMs: 1_000,
      killHardTimeoutMs: 2_000,
    });

    const p1 = mgr.start(12345);
    first.stderr.emit("data", Buffer.from("https://old.trycloudflare.com\n"));
    await p1;

    void mgr.stop(); // fire-and-forget, old child not yet exited
    const second = new FakeChild();
    current = second;
    const p2 = mgr.start(12345);
    await waitFor(() => first.killed);
    await new Promise((r) => setTimeout(r, 20));
    expect(spawnArgs.length).toBe(1); // blocked on the pending teardown

    first.exitNow();
    await waitFor(() => spawnArgs.length === 2);
    second.stderr.emit("data", Buffer.from("https://new.trycloudflare.com\n"));
    const res = await p2;
    expect(res.url).toBe("https://new.trycloudflare.com");

    void mgr.stop();
  });

  test("retry after a failed start awaits the failed child's exit before re-spawning", async () => {
    // Startup failure (finishReject) tears the child down via beginTeardown and
    // records pendingTeardown. A retried start() with no live child must still
    // await that teardown, else it spawns into the port the dying child holds.
    const first = new FakeChild({ autoExit: false });
    let current: FakeChild = first;
    const spawnArgs: string[][] = [];
    const mgr = new TunnelManager({
      binaryPath: () => "/fake/cloudflared",
      spawn: (_cmd, args) => {
        spawnArgs.push(args);
        return current as unknown as import("node:child_process").ChildProcess;
      },
      timeoutMs: 20, // force a fast URL-timeout failure
      checkReady: async () => true,
      readyTimeoutMs: 60,
      readyIntervalMs: 5,
      healthCheckIntervalMs: 0,
      killGraceMs: 1_000,
      killHardTimeoutMs: 2_000,
    });

    // First start never gets a URL → rejects; finishReject SIGTERMs the child.
    const p1 = mgr.start(12345);
    await expect(p1).rejects.toThrow(/超时/);
    await waitFor(() => first.killed);

    // Immediate retry: no live child, but the failed child is still dying.
    const second = new FakeChild();
    current = second;
    const p2 = mgr.start(12345);
    await new Promise((r) => setTimeout(r, 20));
    expect(spawnArgs.length).toBe(1); // blocked on the failed child's teardown

    first.exitNow();
    await waitFor(() => spawnArgs.length === 2);
    second.stderr.emit("data", Buffer.from("https://retry.trycloudflare.com\n"));
    const res = await p2;
    expect(res.url).toBe("https://retry.trycloudflare.com");

    void mgr.stop();
  });

  test("a second stop() before exit does not drop the pending teardown", async () => {
    // Duplicate mobileRemote:stop (or stop() after finishReject) re-enters
    // beginTeardown with no live child. It must NOT clear pendingTeardown — a
    // start() afterwards still has to wait for the original child to exit.
    const first = new FakeChild({ autoExit: false });
    let current: FakeChild = first;
    const spawnArgs: string[][] = [];
    const mgr = new TunnelManager({
      binaryPath: () => "/fake/cloudflared",
      spawn: (_cmd, args) => {
        spawnArgs.push(args);
        return current as unknown as import("node:child_process").ChildProcess;
      },
      timeoutMs: 50,
      checkReady: async () => true,
      readyTimeoutMs: 60,
      readyIntervalMs: 5,
      healthCheckIntervalMs: 0,
      killGraceMs: 1_000,
      killHardTimeoutMs: 2_000,
    });

    const p1 = mgr.start(12345);
    first.stderr.emit("data", Buffer.from("https://old.trycloudflare.com\n"));
    await p1;

    void mgr.stop(); // records pendingTeardown (child still dying)
    void mgr.stop(); // duplicate — must not clear the pending wait
    await waitFor(() => first.killed);

    const second = new FakeChild();
    current = second;
    const p2 = mgr.start(12345);
    await new Promise((r) => setTimeout(r, 20));
    expect(spawnArgs.length).toBe(1); // still blocked despite the duplicate stop

    first.exitNow();
    await waitFor(() => spawnArgs.length === 2);
    second.stderr.emit("data", Buffer.from("https://new.trycloudflare.com\n"));
    await p2;

    void mgr.stop();
  });

  test("teardown escalates to SIGKILL when the child ignores SIGTERM", async () => {
    // cloudflared's SIGTERM is a graceful drain (~30s). If it doesn't exit within
    // killGraceMs we must SIGKILL so the port is freed promptly.
    const first = new FakeChild({ autoExit: false });
    let current: FakeChild = first;
    const spawnArgs: string[][] = [];
    const mgr = new TunnelManager({
      binaryPath: () => "/fake/cloudflared",
      spawn: (_cmd, args) => {
        spawnArgs.push(args);
        return current as unknown as import("node:child_process").ChildProcess;
      },
      timeoutMs: 50,
      checkReady: async () => true,
      readyTimeoutMs: 60,
      readyIntervalMs: 5,
      healthCheckIntervalMs: 0,
      killGraceMs: 15, // escalate fast in the test
      killHardTimeoutMs: 200,
    });

    const p1 = mgr.start(12345);
    first.stderr.emit("data", Buffer.from("https://old.trycloudflare.com\n"));
    await p1;

    const second = new FakeChild();
    current = second;
    const p2 = mgr.start(12345);
    // SIGTERM first, then SIGKILL after the grace window (child ignores SIGTERM).
    await waitFor(() => first.signals.includes("SIGKILL"));
    expect(first.signals[0]).toBe("SIGTERM");
    first.exitNow("SIGKILL");
    await waitFor(() => spawnArgs.length === 2);
    second.stderr.emit("data", Buffer.from("https://new.trycloudflare.com\n"));
    await p2;

    void mgr.stop();
  });

  test("emits error on spawn failure", async () => {
    const child = new FakeChild();
    const mgr = makeManager(child);
    const errors: unknown[] = [];
    mgr.on("status", (s: string, detail?: unknown) => {
      if (s === "error") errors.push(detail);
    });
    const promise = mgr.start(12345);
    child.emit("error", new Error("spawn ENOENT"));
    await expect(promise).rejects.toThrow();
    expect(errors.length).toBeGreaterThan(0);
  });
});
