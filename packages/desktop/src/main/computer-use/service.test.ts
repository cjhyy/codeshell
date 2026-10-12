import { afterEach, describe, expect, test } from "bun:test";
import { CuaDriverHost } from "./cua-driver-host.js";
import { hostMcpServersEnv, initCuaComputerUse, resetCuaComputerUse } from "./service.js";

const DRIVER = { CODESHELL_CUA_DRIVER_PATH: "/bin/sh" };

afterEach(() => resetCuaComputerUse());

describe("Computer Use spike gates", () => {
  test("stays off unless the flag is on", () => {
    const decision = initCuaComputerUse({ flags: {}, platform: "darwin", isPackaged: false, env: DRIVER });
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

  test("exposes host:cua-driver to the worker once enabled", () => {
    const decision = initCuaComputerUse({
      flags: { computer_use_cua: true },
      platform: "darwin",
      isPackaged: false,
      env: DRIVER,
      createHost: (options) => new CuaDriverHost({ ...options, socketPath: "/tmp/t.sock" }),
    });
    expect(decision.enabled).toBe(true);
    const parsed = JSON.parse(hostMcpServersEnv()!);
    expect(parsed["host:cua-driver"].command).toBe("/bin/sh");
    expect(parsed["host:cua-driver"].args).toEqual(["mcp", "--embedded", "--socket", "/tmp/t.sock"]);
    expect(parsed["host:cua-driver"].inlineImages).toBe(true);
  });
});
