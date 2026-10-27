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

describe("RemoteBridge stdin errors", () => {
  test("rejects connection and terminates the child on an early pipe error", async () => {
    const child = makeFakeChild();
    let kills = 0;
    child.kill = () => {
      kills++;
    };
    const bridge = new RemoteBridge({ host: "owned-fixture" }, () => child as never);
    const connecting = bridge.connect();
    const error = Object.assign(new Error("owned EPIPE"), { code: "EPIPE" });
    expect(() => child.stdin.emit("error", error)).not.toThrow();
    await expect(connecting).rejects.toBe(error);
    expect(bridge.isConnected).toBe(false);
    expect(kills).toBe(1);
  });

  test("disconnects, wakes pending readers, and reports the write failure once", async () => {
    const child = makeFakeChild();
    let kills = 0;
    child.kill = () => {
      kills++;
    };
    const bridge = new RemoteBridge({ host: "owned-fixture" }, () => child as never);
    const connecting = bridge.connect();
    child.stdout.write("ready\n");
    await connecting;
    const iterator = bridge.messages();
    const pending = iterator.next();
    const error = Object.assign(new Error("owned EPIPE"), { code: "EPIPE" });
    // An actual Writable write failure emits both its callback and error event.
    child.stdin._write = (_chunk, _encoding, callback) => callback(error);
    bridge.send({ type: "owned-message" });
    await expect(pending).rejects.toBe(error);
    expect(bridge.isConnected).toBe(false);
    expect(() => bridge.send({ type: "later" })).toThrow("owned EPIPE");
    expect(kills).toBe(1);
  });
});

test("invalid message serialization does not close a healthy SSH transport", async () => {
  const child = makeFakeChild();
  let kills = 0;
  child.kill = () => {
    kills++;
  };
  const bridge = new RemoteBridge({ host: "owned-fixture" }, () => child as never);
  const connecting = bridge.connect();
  child.stdout.write("ready\n");
  await connecting;
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(() => bridge.send(cyclic)).toThrow();
  expect(bridge.isConnected).toBe(true);
  expect(kills).toBe(0);
  bridge.send({ message: "still connected" });
  expect(child.stdin.read()?.toString()).toBe('{"message":"still connected"}\n');
  bridge.disconnect();
});

test("reconnecting cannot erase a failed reader's transport error", async () => {
  const first = makeFakeChild();
  const second = makeFakeChild();
  const children = [first, second];
  const bridge = new RemoteBridge({ host: "owned-fixture" }, () => children.shift() as never);
  const connected = bridge.connect();
  first.stdout.write("ready\n");
  await connected;
  const pending = bridge.messages().next();
  const error = new Error("first transport failed");
  first.stdin.emit("error", error);
  const reconnected = bridge.connect();
  second.stdout.write("ready\n");
  await reconnected;
  await expect(pending).rejects.toBe(error);
  expect(bridge.isConnected).toBe(true);
  bridge.disconnect();
});
