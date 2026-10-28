import { afterAll, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";

// Restore module exports so this focused fixture cannot replace process or
// native-host dependencies for another test loaded in the same Bun shard.
const originalProcess = { ...(await import("node:child_process")) };
const originalDriver = {
  ...(await import("../packages/desktop/src/main/computer-use/cua-driver-host.js")),
};
const desktopRequire = createRequire(new URL("../packages/desktop/package.json", import.meta.url));
const originalElectron = { ...(await import(desktopRequire.resolve("electron"))) };
afterAll(() => {
  mock.module("node:child_process", () => originalProcess);
  mock.module("../packages/desktop/src/main/computer-use/cua-driver-host.js", () => originalDriver);
  mock.module("electron", () => originalElectron);
});

const processes: FakeChild[] = [];
const calls: string[] = [];
class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signals: string[] = [];
  constructor(readonly command: string) {
    super();
    processes.push(this);
    if (command === "fixture-mcp")
      this.stdin.on("data", (data) => {
        const message = JSON.parse(data.toString());
        if (message.method === "initialize")
          queueMicrotask(() => {
            this.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\n");
          });
        if (message.method === "tools/call") calls.push(message.params.name);
        // Hold the first tool request so cancellation happens during real pending
        // request bookkeeping, not only before a run has started.
      });
  }
  kill(signal: string) {
    this.signals.push(signal);
    this.exitCode = 1;
    queueMicrotask(() => this.emit("close"));
    return true;
  }
}
mock.module("node:child_process", () => ({ spawn: (command: string) => new FakeChild(command) }));
mock.module("../packages/desktop/src/main/computer-use/cua-driver-host.js", () => ({
  CuaDriverHost: class {
    constructor(readonly options: any) {}
    async start() {
      this.options.spawn("fixture-daemon", [], {});
    }
    mcpDeclaration() {
      return { command: "fixture-mcp", args: [], env: {} };
    }
    async stop() {}
  },
}));
mock.module("electron", () => ({
  screen: {
    getAllDisplays: () => [{ id: 3, workArea: { x: 0, y: 0, width: 1600, height: 1000 } }],
  },
  BrowserWindow: class extends EventEmitter {
    static getAllWindows() {
      return [];
    }
    webContents = { setWindowOpenHandler() {} };
    destroyed = false;
    async loadURL() {}
    show() {}
    getBounds() {
      return { x: 300, y: 130, width: 1240, height: 820 };
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  },
}));
const { createMimiNativeTrial } = await import("../packages/desktop/scripts/mimi-native-trial.js");
function fixture(requestTimeoutMs = 1_000) {
  processes.length = 0;
  calls.length = 0;
  return createMimiNativeTrial({
    companion: { mcpProxy: {}, update: async () => {} } as any,
    driverPath: "fixture-driver",
    displayId: 3,
    status() {},
    requestTimeoutMs,
  });
}
async function waitForRequest() {
  const until = Date.now() + 500;
  while (!calls.length && Date.now() < until) await Bun.sleep(1);
  expect(calls).toEqual(["list_windows"]);
}
describe("native trial cancellation without a desktop or native driver", () => {
  test("stopping a pending request kills its owned daemon and prevents later input or restart", async () => {
    const trial = fixture();
    const result = trial.run().catch((error) => error);
    await waitForRequest();
    await trial.cancel();
    expect((await result).message).toContain("已停止");
    expect(processes.find((p) => p.command === "fixture-daemon")?.signals).toContain("SIGKILL");
    expect(processes.find((p) => p.command === "fixture-mcp")?.signals).toContain("SIGTERM");
    await expect(trial.run()).rejects.toThrow("已停止");
    expect(calls).toEqual(["list_windows"]);
  });
  test("a tool timeout stops the input process instead of only rejecting a promise", async () => {
    const trial = fixture(20);
    const result = trial.run().catch((error) => error);
    await waitForRequest();
    expect((await result).message).toContain("超时");
    expect(processes.find((p) => p.command === "fixture-daemon")?.signals).toContain("SIGKILL");
    await expect(trial.run()).rejects.toThrow("已停止");
    expect(calls).toEqual(["list_windows"]);
  });
});
