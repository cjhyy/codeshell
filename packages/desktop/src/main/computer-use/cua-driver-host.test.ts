import { describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CuaDriverHost,
  resolveCuaDriverPath,
  type CuaDriverHostOptions,
} from "./cua-driver-host.js";

class FakeChild extends EventEmitter {
  pid: number | undefined = 1234;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kills: string[] = [];
  autoExit = true;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.kills.push(signal);
    if (this.autoExit) queueMicrotask(() => this.exit(signal));
    return true;
  }
  exit(signal: NodeJS.Signals): void {
    this.signalCode = signal;
    this.emit("exit", null, signal);
  }
  crash(code = 1): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

function controlledSleep() {
  const pending = new Map<number, Array<() => void>>();
  return {
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        const waits = pending.get(ms) ?? [];
        waits.push(resolve);
        pending.set(ms, waits);
      }),
    resolve: (ms: number) => {
      const resolve = pending.get(ms)?.shift();
      expect(resolve).toBeDefined();
      resolve!();
    },
  };
}

function harness(
  opts: {
    ready?: () => boolean | Promise<boolean>;
    maxRestarts?: number;
    sleep?: (ms: number) => Promise<void>;
    createChild?: () => FakeChild;
    hostOptions?: Partial<CuaDriverHostOptions>;
  } = {},
) {
  const spawns: Array<{
    command: string;
    args: string[];
    options: SpawnOptions;
    child: FakeChild;
  }> = [];
  const sleeps: number[] = [];
  const host = new CuaDriverHost({
    driverPath: "/opt/cua/cua-driver",
    hostBundleId: "com.cjhyy.codeshell",
    socketPath: "/tmp/codeshell-cua-test.sock",
    parentEnv: { PATH: "/usr/bin", HOME: "/Users/u", OPENAI_API_KEY: "sk-secret" },
    spawn: (command, args, options) => {
      const child = opts.createChild?.() ?? new FakeChild();
      spawns.push({ command, args, options, child });
      return child as unknown as ChildProcess;
    },
    socketReady: opts.ready ?? (() => true),
    readyTimeoutMs: 200,
    maxRestarts: opts.maxRestarts,
    sleep: async (ms) => {
      sleeps.push(ms);
      if (opts.sleep) return opts.sleep(ms);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    ...opts.hostOptions,
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

  test("fails and terminates the child when the socket never appears", async () => {
    const { host, spawns } = harness({ ready: () => false });
    let error: unknown;
    await host.start().catch((e) => (error = e));
    expect(String(error)).toContain("socket not ready");
    expect(host.status().state).toBe("failed");
    expect(spawns[0]!.child.kills).toContain("SIGTERM");
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

  for (const expired of [false, true]) {
    test(`stop cancels pending startup${expired ? " after the readiness deadline" : ""}`, async () => {
      let now = 0;
      const clock = spyOn(Date, "now").mockImplementation(() => now);
      const sleeper = controlledSleep();
      const { host, spawns } = harness({ ready: () => false, sleep: sleeper.sleep });
      try {
        const startup = host.start().catch((error) => error);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(host.status().state).toBe("starting");
        await host.stop();
        if (expired) now = 201;
        sleeper.resolve(50);
        expect(String(await startup)).toContain("stopped");
        expect(host.status().state).toBe("stopped");
        await expect(host.start()).rejects.toThrow("stopped");
        expect(spawns).toHaveLength(1);
      } finally {
        clock.mockRestore();
      }
    });
  }

  test("stop waits for the exit event after escalating to SIGKILL", async () => {
    const sleeper = controlledSleep();
    const { host, spawns } = harness({ sleep: sleeper.sleep });
    await host.start();
    const child = spawns[0]!.child;
    child.autoExit = false;
    let stopped = false;
    const shutdown = host.stop().then(() => {
      stopped = true;
    });
    expect(child.kills).toEqual(["SIGTERM"]);
    sleeper.resolve(3_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(stopped).toBe(false);
    child.exit("SIGKILL");
    await shutdown;
    expect(stopped).toBe(true);
    expect(host.status().state).toBe("stopped");
  });

  test("stop remains bounded when forced termination never reports an exit", async () => {
    const sleeper = controlledSleep();
    const { host, spawns } = harness({ sleep: sleeper.sleep });
    await host.start();
    const child = spawns[0]!.child;
    child.autoExit = false;
    const shutdown = host.stop();
    sleeper.resolve(3_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    sleeper.resolve(1_000);
    await shutdown;
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(host.status().state).toBe("stopped");
    expect(host.status().lastError).toContain("did not exit after SIGKILL");
  });

  test("concurrent stop calls await the same child termination", async () => {
    const { host, spawns } = harness();
    await host.start();
    const child = spawns[0]!.child;
    child.autoExit = false;
    const first = host.stop();
    const second = host.stop();
    expect(second).toBe(first);
    expect(child.kills).toEqual(["SIGTERM"]);
    child.exit("SIGTERM");
    await Promise.all([first, second]);
  });

  test("records synchronous spawn failures and allows a later retry", async () => {
    let attempts = 0;
    const { host } = harness({
      hostOptions: {
        spawn: () => {
          if (++attempts === 1) throw new Error("executable rejected");
          return new FakeChild() as unknown as ChildProcess;
        },
      },
    });
    await expect(host.start()).rejects.toThrow("spawn failed: executable rejected");
    expect(host.status().state).toBe("failed");
    expect(host.status().lastError).toContain("executable rejected");
    await host.start();
    expect(attempts).toBe(2);
    expect(host.status().state).toBe("running");
    await host.stop();
  });

  test("handles a failed spawn without signaling a nonexistent process", async () => {
    const child = new FakeChild();
    child.pid = undefined;
    const { host } = harness({
      ready: () => false,
      createChild: () => {
        queueMicrotask(() => child.emit("error", new Error("ENOENT")));
        return child;
      },
    });
    await expect(host.start()).rejects.toThrow("spawn failed: ENOENT");
    expect(host.status().state).toBe("failed");
    expect(child.kills).toEqual([]);
    // Child-process errors can recur (for example from a failed kill).
    child.emit("error", new Error("another child error"));
    await host.stop();
  });

  test("does not start another daemon until failed startup cleanup finishes", async () => {
    let readinessFails = true;
    const { host, spawns } = harness({
      ready: () => {
        if (readinessFails) throw new Error("readiness probe failed");
        return true;
      },
      createChild: () => {
        const child = new FakeChild();
        child.autoExit = !readinessFails;
        return child;
      },
    });
    const startup = host.start();
    const failure = startup.catch((error) => error);
    expect(host.start()).toBe(startup);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.child.kills).toEqual(["SIGTERM"]);
    spawns[0]!.child.exit("SIGTERM");
    expect(String(await failure)).toContain("readiness probe failed");
    readinessFails = false;
    await host.start();
    expect(spawns).toHaveLength(2);
    await host.stop();
  });

  test("blocks a new generation while failed startup termination is unconfirmed", async () => {
    const sleeper = controlledSleep();
    let readinessFails = true;
    const { host, spawns } = harness({
      sleep: sleeper.sleep,
      ready: () => {
        if (readinessFails) throw new Error("readiness probe failed");
        return true;
      },
      createChild: () => {
        const child = new FakeChild();
        child.autoExit = !readinessFails;
        return child;
      },
    });
    const failure = host.start().catch((error) => error);
    sleeper.resolve(3_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    sleeper.resolve(1_000);
    expect(String(await failure)).toContain("previous daemon did not exit after SIGKILL");
    await expect(host.start()).rejects.toThrow("previous cua-driver daemon is still running");
    expect(spawns).toHaveLength(1);
    spawns[0]!.child.exit("SIGKILL");
    readinessFails = false;
    await host.start();
    expect(spawns).toHaveLength(2);
    await host.stop();
  });

  test("rejects readiness that completes after the child has exited", async () => {
    let resolveReady!: (ready: boolean) => void;
    const ready = new Promise<boolean>((resolve) => {
      resolveReady = resolve;
    });
    const { host, spawns } = harness({ ready: () => ready });
    const startup = host.start().catch((error) => error);
    spawns[0]!.child.crash();
    resolveReady(true);
    expect(String(await startup)).toContain("daemon exited during startup");
    expect(host.status().state).toBe("failed");
    await host.stop();
  });

  test("start calls during restart backoff await the scheduled generation", async () => {
    const sleeper = controlledSleep();
    const { host, spawns } = harness({ sleep: sleeper.sleep });
    await host.start();
    spawns[0]!.child.crash();
    const restarted = host.start();
    expect(spawns).toHaveLength(1);
    expect(host.status().state).toBe("restarting");
    sleeper.resolve(1_000);
    await restarted;
    expect(spawns).toHaveLength(2);
    await host.stop();
  });

  test("stopping during restart backoff prevents another generation", async () => {
    const sleeper = controlledSleep();
    const { host, spawns } = harness({ sleep: sleeper.sleep });
    await host.start();
    spawns[0]!.child.crash();
    const restarted = host.start().catch((error) => error);
    await host.stop();
    sleeper.resolve(1_000);
    expect(String(await restarted)).toContain("stopped");
    expect(spawns).toHaveLength(1);
    expect(host.status().state).toBe("stopped");
  });

  test("failed restart attempts consume the remaining exponential retry budget", async () => {
    const sleeper = controlledSleep();
    const child = new FakeChild();
    let attempts = 0;
    const { host } = harness({
      maxRestarts: 3,
      sleep: sleeper.sleep,
      hostOptions: {
        spawn: () => {
          if (++attempts > 1) throw new Error("temporarily unavailable");
          return child as unknown as ChildProcess;
        },
      },
    });
    await host.start();
    child.crash();
    for (const delay of [1_000, 2_000, 4_000]) {
      sleeper.resolve(delay);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(attempts).toBe(4);
    expect(host.status().state).toBe("failed");
    expect(host.status().lastError).toContain("restart budget exhausted");
    await host.stop();
  });

  test("default sockets use separate private directories and clean up independently", async () => {
    const first = harness({ hostOptions: { socketPath: undefined } }).host;
    const second = harness({ hostOptions: { socketPath: undefined } }).host;
    const firstPath = first.status().socketPath;
    const secondPath = second.status().socketPath;
    expect(firstPath).not.toBe(secondPath);
    expect(Buffer.byteLength(firstPath)).toBeLessThan(104);
    try {
      await Promise.all([first.start(), second.start()]);
      expect(statSync(dirname(firstPath)).mode & 0o777).toBe(0o700);
      expect(statSync(dirname(secondPath)).mode & 0o777).toBe(0o700);
      await first.stop();
      expect(existsSync(dirname(firstPath))).toBe(false);
      expect(existsSync(dirname(secondPath))).toBe(true);
      expect(second.mcpDeclaration().args.at(-1)).toBe(secondPath);
    } finally {
      await Promise.all([first.stop(), second.stop()]);
    }
    expect(existsSync(dirname(secondPath))).toBe(false);
  });

  test("recreates its private default directory for the next daemon generation", async () => {
    const sleeper = controlledSleep();
    const { host, spawns } = harness({
      sleep: sleeper.sleep,
      hostOptions: { socketPath: undefined },
    });
    const socketPath = host.status().socketPath;
    try {
      await host.start();
      spawns[0]!.child.crash();
      expect(existsSync(dirname(socketPath))).toBe(false);
      const restarted = host.start();
      sleeper.resolve(1_000);
      await restarted;
      expect(host.status().socketPath).toBe(socketPath);
      expect(host.status().generation).toBe(2);
      expect(statSync(dirname(socketPath)).mode & 0o777).toBe(0o700);
      expect(spawns).toHaveLength(2);
    } finally {
      await host.stop();
    }
    expect(existsSync(dirname(socketPath))).toBe(false);
  });

  test("an existing socket belongs to its listener and is not unlinked", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cua-test-"));
    const socketPath = join(directory, "driver.sock");
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const { host, spawns } = harness({ hostOptions: { socketPath } });
    try {
      await expect(host.start()).rejects.toThrow("socket path is already in use");
      expect(spawns).toHaveLength(0);
      await host.stop();
      expect(statSync(socketPath).isSocket()).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  for (const action of ["restart", "stop"] as const) {
    test(`preserves a replacement listener during crash backoff on ${action}`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "cua-test-"));
      const socketPath = join(directory, "driver.sock");
      const sleeper = controlledSleep();
      const { host, spawns } = harness({ sleep: sleeper.sleep, hostOptions: { socketPath } });
      const replacement = createServer((socket) => socket.end("replacement"));
      try {
        await host.start();
        spawns[0]!.child.crash();
        expect(host.status().state).toBe("restarting");
        await new Promise<void>((resolve) => replacement.listen(socketPath, resolve));
        if (action === "restart") {
          const restarted = host.start().catch((error) => error);
          sleeper.resolve(1_000);
          expect(String(await restarted)).toContain("socket path is already in use");
          expect(spawns).toHaveLength(1);
        }
        await host.stop();
        expect(statSync(socketPath).isSocket()).toBe(true);
        const reply = await new Promise<string>((resolve, reject) => {
          const socket = createConnection(socketPath);
          socket.once("data", (data) => {
            socket.destroy();
            resolve(data.toString());
          });
          socket.once("error", reject);
        });
        expect(reply).toBe("replacement");
      } finally {
        await host.stop();
        if (replacement.listening)
          await new Promise<void>((resolve) => replacement.close(() => resolve()));
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  test("an existing regular file is neither socket readiness nor cleanup authority", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cua-test-"));
    const socketPath = join(directory, "driver.sock");
    writeFileSync(socketPath, "keep this file");
    const { host, spawns } = harness({ hostOptions: { socketPath, socketReady: undefined } });
    try {
      await expect(host.start()).rejects.toThrow("socket path is already in use");
      expect(host.status().state).toBe("failed");
      expect(spawns).toHaveLength(0);
      await host.stop();
      expect(readFileSync(socketPath, "utf8")).toBe("keep this file");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a regular file created during startup cannot satisfy socket readiness", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cua-test-"));
    const socketPath = join(directory, "driver.sock");
    const child = new FakeChild();
    const { host } = harness({
      hostOptions: {
        socketPath,
        socketReady: undefined,
        readyTimeoutMs: 25,
        spawn: () => {
          writeFileSync(socketPath, "not a socket");
          return child as unknown as ChildProcess;
        },
      },
    });
    try {
      await expect(host.start()).rejects.toThrow("socket not ready");
      expect(host.status().state).toBe("failed");
      expect(child.kills).toEqual(["SIGTERM"]);
      await host.stop();
      expect(readFileSync(socketPath, "utf8")).toBe("not a socket");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("failed startup relinquishes an explicit socket path before retry", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cua-test-"));
    const socketPath = join(directory, "driver.sock");
    const server = createServer((socket) => socket.destroy());
    let attempts = 0;
    const { host } = harness({
      hostOptions: {
        socketPath,
        spawn: () => {
          attempts++;
          throw new Error("spawn unavailable");
        },
      },
    });
    try {
      await expect(host.start()).rejects.toThrow("spawn unavailable");
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      await expect(host.start()).rejects.toThrow("socket path is already in use");
      expect(attempts).toBe(1);
      await host.stop();
      expect(statSync(socketPath).isSocket()).toBe(true);
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("real readiness waits for a Unix socket listener", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cua-test-"));
    const socketPath = join(directory, "driver.sock");
    const server = createServer((socket) => socket.destroy());
    const sleeper = controlledSleep();
    const { host } = harness({
      sleep: sleeper.sleep,
      hostOptions: { socketPath, socketReady: undefined },
    });
    try {
      const startup = host.start();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(host.status().state).toBe("starting");
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      sleeper.resolve(50);
      await startup;
      expect(host.status().state).toBe("running");
    } finally {
      await host.stop();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
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

  test("an executable directory is not a driver executable", () => {
    expect(
      resolveCuaDriverPath({ env: { CODESHELL_CUA_DRIVER_PATH: tmpdir() }, isPackaged: false }),
    ).toBeUndefined();
  });
});
