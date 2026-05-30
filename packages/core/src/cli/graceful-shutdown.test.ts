import { describe, test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { installGracefulShutdown } from "./graceful-shutdown.js";

// Regression: agent-server-stdio set up long-lived resources (idle sweeper,
// transport, server) but registered no signal handlers, so SIGTERM/SIGINT/
// SIGHUP killed the process without AgentServer.close() cleanup
// (review-2026-05-30, high-severity at agent-server-stdio.ts:159-172).

describe("installGracefulShutdown", () => {
  function makeProc() {
    // A stand-in for `process` — EventEmitter plus a recording exit().
    const proc = new EventEmitter() as EventEmitter & { exit: (code?: number) => void; exitCalls: number[] };
    proc.exitCalls = [];
    proc.exit = (code = 0) => {
      proc.exitCalls.push(code);
    };
    return proc;
  }

  test("a signal triggers close() then exit(0)", () => {
    let closed = 0;
    const proc = makeProc();
    installGracefulShutdown({ close: () => closed++ }, { proc, signals: ["SIGTERM"] });

    proc.emit("SIGTERM");

    expect(closed).toBe(1);
    expect(proc.exitCalls).toEqual([0]);
  });

  test("registers all requested signals", () => {
    let closed = 0;
    const proc = makeProc();
    installGracefulShutdown({ close: () => closed++ }, { proc, signals: ["SIGTERM", "SIGINT", "SIGHUP"] });

    proc.emit("SIGINT");
    expect(closed).toBe(1);

    proc.emit("SIGHUP");
    // Second signal after we already shut down must NOT double-close.
    expect(closed).toBe(1);
  });

  test("close() throwing still exits and does not rethrow", () => {
    const proc = makeProc();
    installGracefulShutdown(
      {
        close: () => {
          throw new Error("boom");
        },
      },
      { proc, signals: ["SIGTERM"] },
    );

    expect(() => proc.emit("SIGTERM")).not.toThrow();
    expect(proc.exitCalls).toEqual([0]);
  });
});
