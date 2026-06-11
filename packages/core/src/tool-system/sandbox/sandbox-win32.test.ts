import { describe, test, expect, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { defaultSandboxConfig, resolveSandboxBackend } from "./index.js";

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
    setPlatform("win32");
    const cfg = defaultSandboxConfig("auto");
    expect(cfg.writableRoots).toContain(tmpdir());
    expect(cfg.writableRoots).not.toContain("/tmp");
  });

  test("POSIX still lists the /tmp family", () => {
    setPlatform("linux");
    const cfg = defaultSandboxConfig("auto");
    expect(cfg.writableRoots).toContain("/tmp");
  });
});
