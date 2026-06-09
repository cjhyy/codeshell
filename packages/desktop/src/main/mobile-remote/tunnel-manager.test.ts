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

function makeManager(child: FakeChild, timeoutMs = 50) {
  return new TunnelManager({
    binaryPath: () => "/fake/cloudflared",
    spawn: () => child as unknown as import("node:child_process").ChildProcess,
    timeoutMs,
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
