import { describe, test, expect, afterEach } from "bun:test";
import { defaultSandboxConfig, defaultSandboxTempRoots, resolveSandboxBackend } from "./index.js";

// P5: Windows has no OS sandbox backend. `auto` must fail-OPEN (downgrade to
// the `off` backend, run unsandboxed + warn) rather than fail-closed/throw —
// the agreed降级. And defaultSandboxConfig must not hardcode /tmp on Windows.

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}
afterEach(() => {
  setPlatform(realPlatform);
  delete process.env.CODE_SHELL_SANDBOX_QUIET;
});

describe("sandbox on Windows (P5)", () => {
  test("auto fails open to the off backend (does not throw)", async () => {
    setPlatform("win32");
    process.env.CODE_SHELL_SANDBOX_QUIET = "1"; // silence the stderr warning in tests
    const backend = await resolveSandboxBackend(defaultSandboxConfig("auto"), "C:\\proj");
    expect(backend.name).toBe("off");
  });

  test("defaultSandboxConfig uses the OS temp dir on Windows, not /tmp", () => {
    expect(defaultSandboxTempRoots("win32", "C:\\Users\\runner\\AppData\\Local\\Temp")).toEqual([
      "C:\\Users\\runner\\AppData\\Local\\Temp",
    ]);
  });

  test("POSIX still lists the /tmp family", () => {
    expect(defaultSandboxTempRoots("linux", "/custom/tmp")).toContain("/tmp");
  });
});
