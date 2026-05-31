import { describe, test, expect } from "bun:test";
import { homedir } from "node:os";
import {
  defaultSandboxConfig,
  detectSandboxCapabilities,
  resolveSandboxBackend,
  expandPath,
  expandConfig,
  type SandboxConfig,
} from "./index.js";

// Keep these tests quiet — they intentionally exercise downgrade/missing-root
// paths that would otherwise print warnings.
process.env.CODE_SHELL_SANDBOX_QUIET = "1";

describe("defaultSandboxConfig", () => {
  test("auto by default, workspace + tmp writable, creds denied", () => {
    const c = defaultSandboxConfig();
    expect(c.mode).toBe("auto");
    expect(c.writableRoots).toContain("${workspace}");
    expect(c.writableRoots).toContain("/tmp");
    expect(c.deniedReads).toContain("~/.ssh");
    expect(c.deniedReads).toContain("~/.code-shell");
    expect(c.network).toBe("allow");
  });

  test("honors an explicit mode", () => {
    expect(defaultSandboxConfig("off").mode).toBe("off");
  });
});

describe("expandPath", () => {
  test("expands ${workspace} to cwd", () => {
    expect(expandPath("${workspace}", "/proj")).toBe("/proj");
    expect(expandPath("${workspace}/sub", "/proj")).toBe("/proj/sub");
  });
  test("expands ~ to home", () => {
    expect(expandPath("~", "/proj")).toBe(homedir());
    expect(expandPath("~/.ssh", "/proj")).toBe(homedir() + "/.ssh");
  });
  test("leaves absolute paths untouched", () => {
    expect(expandPath("/tmp", "/proj")).toBe("/tmp");
  });
});

describe("expandConfig", () => {
  test("expands placeholders in writableRoots and deniedReads", () => {
    const cfg: SandboxConfig = {
      mode: "off",
      writableRoots: ["${workspace}"],
      deniedReads: ["~/.ssh"],
      network: "allow",
    };
    const out = expandConfig(cfg, "/proj");
    // canonicalize() may resolve symlinks, but the workspace path should still
    // reference /proj (possibly via realpath) and not the literal placeholder.
    expect(out.writableRoots[0]).not.toBe("${workspace}");
    expect(out.deniedReads[0]).not.toContain("~");
  });
});

describe("detectSandboxCapabilities", () => {
  test("returns booleans for each backend", () => {
    const caps = detectSandboxCapabilities();
    expect(typeof caps.seatbelt).toBe("boolean");
    expect(typeof caps.bwrap).toBe("boolean");
  });
});

describe("resolveSandboxBackend", () => {
  test("off mode always resolves to the off backend", async () => {
    const backend = await resolveSandboxBackend(defaultSandboxConfig("off"), "/proj");
    expect(backend.name).toBe("off");
  });

  test("off backend wraps a command as a plain shell invocation", async () => {
    const backend = await resolveSandboxBackend(defaultSandboxConfig("off"), "/proj");
    const wrapped = backend.wrap("echo hi", { shell: "/bin/sh", cwd: "/proj" });
    expect(wrapped.file).toBe("/bin/sh");
    expect(wrapped.args).toContain("echo hi");
  });

  test("auto resolves without throwing and yields a usable backend", async () => {
    const backend = await resolveSandboxBackend(defaultSandboxConfig("auto"), "/proj");
    expect(["off", "seatbelt", "bwrap"]).toContain(backend.name);
  });

  test("explicit unavailable backend fails closed (throws)", async () => {
    const caps = detectSandboxCapabilities();
    // Pick a mode that is NOT available on this host and assert it throws,
    // rather than silently downgrading (security §S4 fail-closed).
    if (!caps.bwrap) {
      await expect(
        resolveSandboxBackend({ ...defaultSandboxConfig("bwrap") }, "/proj"),
      ).rejects.toThrow();
    } else if (!caps.seatbelt) {
      await expect(
        resolveSandboxBackend({ ...defaultSandboxConfig("seatbelt") }, "/proj"),
      ).rejects.toThrow();
    } else {
      // Both available (unusual); nothing to assert for fail-closed here.
      expect(true).toBe(true);
    }
  });
});
