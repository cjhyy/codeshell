import { describe, test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { RemoteBridge, buildSSHArgs } from "./bridge.js";

// buildSSHArgs: identityFile/remoteCommand are discrete argv elements (spawn
// uses no shell), so there is no local command injection — the security
// finding's premise. Also regression-guards the connect() lifecycle: the exit
// handler used `this.connected = false; if (!this.connected)` (always true),
// and there was no resolved-guard, so a post-connect exit re-rejected an
// already-settled promise (review-2026-05-30).

describe("buildSSHArgs", () => {
  test("identityFile is a separate -i argv element, not concatenated", () => {
    const args = buildSSHArgs({ host: "h", identityFile: "/path/to key", port: 2222, user: "u" });
    const i = args.indexOf("-i");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("/path/to key"); // one literal token, spaces and all
    expect(args).toContain("u@h");
    expect(args[args.indexOf("-p") + 1]).toBe("2222");
  });
});

/** Minimal fake ChildProcess for driving connect() without spawning ssh. */
function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    kill: () => void;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => {};
  return child;
}

describe("RemoteBridge connect lifecycle", () => {
  test("resolves once on first stdout, and a later exit does not throw", async () => {
    const child = makeFakeChild();
    const bridge = new RemoteBridge({ host: "h" }, () => child as never);

    const p = bridge.connect();
    // First data → connected/resolve.
    child.stdout.write("hello\n");
    await p;
    expect(bridge.isConnected).toBe(true);

    // A later exit (normal teardown) must not reject the settled promise or
    // throw an unhandled rejection.
    expect(() => child.emit("exit", 0)).not.toThrow();
    expect(bridge.isConnected).toBe(false);
  });

  test("rejects when the process exits before connecting", async () => {
    const child = makeFakeChild();
    const bridge = new RemoteBridge({ host: "h" }, () => child as never);
    const p = bridge.connect();
    child.emit("exit", 255);
    await expect(p).rejects.toThrow(/exited/);
  });
});
