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
  kill(signal?: string): boolean {
    this.killed = true;
    this.killSignal = signal;
    // emulate the process actually exiting after a kill
    queueMicrotask(() => this.emit("exit", null, signal ?? "SIGTERM"));
    return true;
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
