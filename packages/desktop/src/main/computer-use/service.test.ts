import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { CuaDriverHost, type CuaDriverHostOptions } from "./cua-driver-host.js";
import {
  getCuaDriverHost,
  hostMcpServersEnv,
  initCuaComputerUse,
  resetCuaComputerUse,
  type CuaComputerUseInputs,
} from "./service.js";

const DRIVER = { CODESHELL_CUA_DRIVER_PATH: "/bin/sh" };

class FakeChild extends EventEmitter {
  pid = 1234;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kills: NodeJS.Signals[] = [];
  autoExit = true;
  kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal);
    if (this.autoExit) queueMicrotask(() => this.exit(signal));
    return true;
  }
  exit(signal: NodeJS.Signals): void {
    this.signalCode = signal;
    this.emit("exit", null, signal);
  }
  crash(): void {
    this.exitCode = 1;
    this.emit("exit", 1, null);
  }
}

function enabledHarness(overrides: Partial<CuaDriverHostOptions> = {}) {
  const children: FakeChild[] = [];
  const spawnOptions: SpawnOptions[] = [];
  const inputs: CuaComputerUseInputs = {
    flags: { computer_use_cua: true },
    platform: "darwin",
    isPackaged: false,
    env: DRIVER,
    createHost: (options) =>
      new CuaDriverHost({
        ...options,
        socketReady: () => true,
        spawn: (_command, _args, options) => {
          const child = new FakeChild();
          children.push(child);
          spawnOptions.push(options);
          return child as unknown as ChildProcess;
        },
        ...overrides,
      }),
  };
  const decision = initCuaComputerUse(inputs);
  if (!decision.enabled) throw new Error(`unexpected gate: ${decision.reason}`);
  return { host: decision.host, inputs, children, spawnOptions };
}

afterEach(() => resetCuaComputerUse());

describe("Computer Use spike gates", () => {
  test("stays off unless the flag is on", () => {
    const decision = initCuaComputerUse({
      flags: {},
      platform: "darwin",
      isPackaged: false,
      env: DRIVER,
    });
    expect(decision.enabled).toBe(false);
    expect(hostMcpServersEnv()).toBeUndefined();
  });

  test("stays off outside macOS", () => {
    const decision = initCuaComputerUse({
      flags: { computer_use_cua: true },
      platform: "linux",
      isPackaged: false,
      env: DRIVER,
    });
    expect(decision).toEqual({ enabled: false, reason: "unsupported_platform" });
  });

  test("reports a missing driver", () => {
    const decision = initCuaComputerUse({
      flags: { computer_use_cua: true },
      platform: "darwin",
      isPackaged: false,
      env: { CODESHELL_CUA_DRIVER_PATH: "/definitely/missing/cua-driver" },
    });
    expect(decision).toEqual({ enabled: false, reason: "driver_not_found" });
  });

  test("exposes host:cua-driver only after daemon readiness", async () => {
    const { host } = enabledHarness();
    expect(hostMcpServersEnv()).toBeUndefined();
    const startup = host.start();
    expect(host.status().state).toBe("starting");
    expect(hostMcpServersEnv()).toBeUndefined();
    await startup;
    const parsed = JSON.parse(hostMcpServersEnv()!);
    expect(parsed["host:cua-driver"].command).toBe("/bin/sh");
    expect(parsed["host:cua-driver"].args).toEqual([
      "mcp",
      "--embedded",
      "--socket",
      host.status().socketPath,
    ]);
    expect(parsed["host:cua-driver"].inlineImages).toBe(true);
  });

  test("failed startup and stopped hosts are absent from worker declarations", async () => {
    const { host } = enabledHarness({
      spawn: () => {
        throw new Error("spawn unavailable");
      },
    });
    await expect(host.start()).rejects.toThrow("spawn unavailable");
    expect(host.status().state).toBe("failed");
    expect(hostMcpServersEnv()).toBeUndefined();
    await host.stop();
    expect(hostMcpServersEnv()).toBeUndefined();
  });

  test("new workers cannot connect while the daemon is restarting", async () => {
    let resumeBackoff!: () => void;
    const { host, children } = enabledHarness({
      sleep: () =>
        new Promise<void>((resolve) => {
          resumeBackoff = resolve;
        }),
    });
    await host.start();
    children[0]!.crash();
    expect(host.status().state).toBe("restarting");
    expect(hostMcpServersEnv()).toBeUndefined();
    const restarted = host.start().catch((error) => error);
    await host.stop();
    resumeBackoff();
    expect(String(await restarted)).toContain("stopped");
  });

  test("repeated enabled initialization reuses the process-wide host", async () => {
    const { host, inputs, children } = enabledHarness();
    await host.start();
    const repeated = initCuaComputerUse({
      ...inputs,
      createHost: () => {
        throw new Error("must reuse existing host");
      },
    });
    expect(repeated).toEqual({ enabled: true, host });
    expect(getCuaDriverHost()).toBe(host);
    expect(children).toHaveLength(1);
    expect(children[0]!.kills).toEqual([]);
  });

  test("initialization replaces a stopped host", async () => {
    const { host, inputs, children } = enabledHarness();
    await host.start();
    await host.stop();
    const repeated = initCuaComputerUse(inputs);
    expect(repeated.enabled).toBe(true);
    if (!repeated.enabled) throw new Error("expected enabled host");
    expect(repeated.host).not.toBe(host);
    expect(repeated.host.status().socketPath).not.toBe(host.status().socketPath);
    await repeated.host.start();
    expect(children).toHaveLength(2);
  });

  test("turning the flag off immediately revokes registration and stops the old host", async () => {
    const { host, inputs, children } = enabledHarness();
    await host.start();
    expect(initCuaComputerUse({ ...inputs, flags: {} })).toEqual({
      enabled: false,
      reason: "flag_off",
    });
    expect(getCuaDriverHost()).toBeUndefined();
    expect(hostMcpServersEnv()).toBeUndefined();
    expect(host.status().state).toBe("stopped");
    await host.stop();
    expect(children[0]!.kills).toEqual(["SIGTERM"]);
  });

  for (const gate of ["unsupported_platform", "driver_not_found"] as const) {
    test(`${gate} revokes a previously enabled host`, async () => {
      const { host, inputs } = enabledHarness();
      await host.start();
      const changes =
        gate === "unsupported_platform"
          ? { platform: "linux" as const }
          : { env: { CODESHELL_CUA_DRIVER_PATH: "/definitely/missing/cua-driver" } };
      expect(initCuaComputerUse({ ...inputs, ...changes })).toEqual({
        enabled: false,
        reason: gate,
      });
      expect(hostMcpServersEnv()).toBeUndefined();
      expect(host.status().state).toBe("stopped");
      await host.stop();
    });
  }

  test("changing the executable stops the old host and creates a separate one", async () => {
    const { host, inputs, children } = enabledHarness();
    await host.start();
    const replacement = initCuaComputerUse({
      ...inputs,
      env: { CODESHELL_CUA_DRIVER_PATH: "/bin/bash" },
    });
    expect(replacement.enabled).toBe(true);
    if (!replacement.enabled) throw new Error("expected enabled replacement");
    expect(replacement.host).not.toBe(host);
    expect(host.status().state).toBe("stopped");
    expect(replacement.host.status().socketPath).not.toBe(host.status().socketPath);
    await replacement.host.start();
    await host.stop();
    expect(children).toHaveLength(2);
    expect(children[0]!.kills).toEqual(["SIGTERM"]);
    expect(replacement.host.status().state).toBe("running");
  });

  test("reset waits for shutdown while clearing registration immediately", async () => {
    const { host, children } = enabledHarness();
    await host.start();
    children[0]!.autoExit = false;
    let finished = false;
    const reset = resetCuaComputerUse().then(() => {
      finished = true;
    });
    expect(getCuaDriverHost()).toBeUndefined();
    expect(hostMcpServersEnv()).toBeUndefined();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    children[0]!.exit("SIGTERM");
    await reset;
    expect(finished).toBe(true);
  });

  test("forwards the selected environment through the daemon allowlist", async () => {
    const { inputs, spawnOptions } = enabledHarness();
    await resetCuaComputerUse();
    const decision = initCuaComputerUse({
      ...inputs,
      env: {
        ...DRIVER,
        PATH: "/selected/bin",
        HOME: "/selected/home",
        OPENAI_API_KEY: "must-not-reach-daemon",
        CUA_DRIVER_PERMISSION_MODE: "unrestricted",
        CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS: "1",
      },
    });
    if (!decision.enabled) throw new Error("expected enabled host");
    await decision.host.start();
    expect(spawnOptions[0]!.env).toEqual({
      PATH: "/selected/bin",
      HOME: "/selected/home",
      CUA_DRIVER_EMBEDDED: "1",
      CUA_DRIVER_HOST_BUNDLE_ID: "com.cjhyy.codeshell",
      CUA_DRIVER_PERMISSION_MODE: "standard",
    });
  });
});
