import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { CuaDriverHost, resolveCuaDriverPath } from "./cua-driver-host.js";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kills: string[] = [];
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.kills.push(signal);
    this.signalCode = signal;
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
  crash(code = 1): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

function harness(opts: { ready?: () => boolean; maxRestarts?: number } = {}) {
  const spawns: Array<{ command: string; args: string[]; options: SpawnOptions; child: FakeChild }> = [];
  const sleeps: number[] = [];
  const host = new CuaDriverHost({
    driverPath: "/opt/cua/cua-driver",
    hostBundleId: "com.cjhyy.codeshell",
    socketPath: "/tmp/codeshell-cua-test.sock",
    parentEnv: { PATH: "/usr/bin", HOME: "/Users/u", OPENAI_API_KEY: "sk-secret" },
    spawn: (command, args, options) => {
      const child = new FakeChild();
      spawns.push({ command, args, options, child });
      return child as unknown as ChildProcess;
    },
    socketReady: opts.ready ?? (() => true),
    readyTimeoutMs: 200,
    maxRestarts: opts.maxRestarts,
    sleep: async (ms) => {
      sleeps.push(ms);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  });
  return { host, spawns, sleeps };
}

describe("CuaDriverHost", () => {
  test("spawns the embedded daemon directly with an allowlisted env", async () => {
    const { host, spawns } = harness();
    await host.start();
    expect(host.status().state).toBe("running");
    expect(spawns).toHaveLength(1);
    const { command, args, options } = spawns[0]!;
    expect(command).toBe("/opt/cua/cua-driver");
    expect(args).toEqual(["serve", "--embedded", "--socket", "/tmp/codeshell-cua-test.sock"]);
    const env = options.env as Record<string, string>;
    expect(env.CUA_DRIVER_EMBEDDED).toBe("1");
    expect(env.CUA_DRIVER_HOST_BUNDLE_ID).toBe("com.cjhyy.codeshell");
    expect(env.CUA_DRIVER_PERMISSION_MODE).toBe("standard");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS).toBeUndefined();
    expect(options.detached).toBe(false);
  });

  test("concurrent start calls coalesce into one generation", async () => {
    const { host, spawns } = harness();
    await Promise.all([host.start(), host.start(), host.start()]);
    expect(spawns).toHaveLength(1);
    expect(host.status().generation).toBe(1);
  });

  test("mcp declaration points the stdio proxy at the private socket", () => {
    const { host } = harness();
    expect(host.mcpDeclaration()).toEqual({
      command: "/opt/cua/cua-driver",
      args: ["mcp", "--embedded", "--socket", "/tmp/codeshell-cua-test.sock"],
      env: { CUA_DRIVER_EMBEDDED: "1" },
      inlineImages: true,
    });
  });

  test("fails and kills the child when the socket never appears", async () => {
    const { host, spawns } = harness({ ready: () => false });
    let error: unknown;
    await host.start().catch((e) => (error = e));
    expect(String(error)).toContain("socket not ready");
    expect(host.status().state).toBe("failed");
    expect(spawns[0]!.child.kills).toContain("SIGKILL");
  });

  test("restarts after an unexpected exit, then gives up after the budget", async () => {
    const { host, spawns, sleeps } = harness({ maxRestarts: 1 });
    await host.start();
    spawns[0]!.child.crash();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(spawns).toHaveLength(2);
    expect(sleeps).toContain(1000);
    expect(host.status().state).toBe("running");
    spawns[1]!.child.crash();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(spawns).toHaveLength(2);
    expect(host.status().state).toBe("failed");
  });

  test("stop terminates the daemon and blocks later starts", async () => {
    const { host, spawns } = harness();
    await host.start();
    await host.stop();
    expect(spawns[0]!.child.kills[0]).toBe("SIGTERM");
    expect(host.status().state).toBe("stopped");
    let error: unknown;
    await host.start().catch((e) => (error = e));
    expect(String(error)).toContain("stopped");
  });
});

describe("resolveCuaDriverPath", () => {
  test("an explicit override wins and must be executable", () => {
    expect(
      resolveCuaDriverPath({
        env: { CODESHELL_CUA_DRIVER_PATH: "/x/cua-driver" },
        isPackaged: false,
        isExecutable: () => true,
      }),
    ).toBe("/x/cua-driver");
    expect(
      resolveCuaDriverPath({
        env: { CODESHELL_CUA_DRIVER_PATH: "/x/cua-driver" },
        isPackaged: false,
        isExecutable: () => false,
      }),
    ).toBeUndefined();
  });

  test("a packaged app prefers its bundled copy", () => {
    expect(
      resolveCuaDriverPath({
        env: {},
        isPackaged: true,
        resourcesPath: "/App/Contents/Resources",
        isExecutable: () => true,
      }),
    ).toBe("/App/Contents/Resources/cua-driver/cua-driver");
  });
});
