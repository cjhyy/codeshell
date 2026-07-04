import { describe, test, expect, afterEach } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import {
  resolveSpawnTarget,
  killProcessGroup,
  groupAlive,
  buildSandboxEnv,
  mergeShellEnv,
  ENV_DENY_REGEX,
  resolveShellInvocation,
} from "./spawn-common.js";
import { createOffBackend } from "../tool-system/sandbox/off.js";
import type { SandboxBackend } from "../tool-system/sandbox/index.js";

function testShPath(): string | undefined {
  if (process.platform !== "win32") return "/bin/sh";
  try {
    const msysPath = execFileSync("which", ["sh"], { encoding: "utf8", timeout: 3000 }).trim();
    if (!msysPath) return undefined;
    return execFileSync("cygpath", ["-w", msysPath], { encoding: "utf8", timeout: 3000 }).trim();
  } catch {
    return undefined;
  }
}

describe("resolveSpawnTarget", () => {
  test("no sandbox → shell -c command", () => {
    const t = resolveSpawnTarget("echo hi", { cwd: "/tmp", shell: "/bin/bash" });
    expect(t.file).toBe("/bin/bash");
    expect(t.args).toEqual(["-c", "echo hi"]);
    expect(t.cleanup).toBeUndefined();
  });

  test("off backend → platform shell invocation (POSIX -c)", () => {
    const t = resolveSpawnTarget("echo hi", {
      cwd: "/tmp",
      shell: "/bin/zsh",
      sandbox: createOffBackend(),
    });
    expect(t.file).toBe("/bin/zsh");
    expect(t.args).toEqual(["-c", "echo hi"]);
  });

  test("off backend on Windows → cmd.exe /c, NOT the hardcoded -c (Windows Bash hang regression)", () => {
    // Regression: createOffBackend().wrap() used to hardcode ["-c", command]. On
    // Windows that produced `cmd.exe -c "..."` — cmd treats -c as a filename and
    // hangs in interactive mode until timeout, so Bash "never ran". off.wrap() now
    // delegates to resolveShellInvocation, which gives win → /c.
    const orig = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const t = resolveSpawnTarget("echo hi", {
        cwd: "C:\\tmp",
        shell: "C:\\Windows\\System32\\cmd.exe",
        sandbox: createOffBackend(),
      });
      expect(t.file).toBe("C:\\Windows\\System32\\cmd.exe");
      expect(t.args).toEqual(["/c", "echo hi"]);
      expect(t.args).not.toContain("-c");
    } finally {
      Object.defineProperty(process, "platform", { value: orig, configurable: true });
    }
  });

  test("a REAL sandbox backend still goes through wrap()", () => {
    // Only `off` bypasses wrap; a genuine sandbox (name !== "off") must delegate,
    // because the flag form is that backend's responsibility (e.g. seatbelt).
    const fakeSandbox: SandboxBackend = {
      name: "seatbelt",
      wrap: (command, o) => ({
        file: "sandbox-exec",
        args: ["-p", "profile", o.shell, "-c", command],
      }),
    };
    const t = resolveSpawnTarget("echo hi", {
      cwd: "/tmp",
      shell: "/bin/bash",
      sandbox: fakeSandbox,
    });
    expect(t.file).toBe("sandbox-exec");
    expect(t.args).toEqual(["-p", "profile", "/bin/bash", "-c", "echo hi"]);
  });
});

describe("off backend on Windows — platform-correct command flag", () => {
  // Bash always passes a sandbox backend (off at minimum), so resolveSpawnTarget
  // takes the wrap() branch and the no-sandbox platform fallback never runs.
  // wrap() itself must therefore be platform-aware: cmd.exe has no -c flag —
  // `cmd.exe -c <cmd>` drops into an interactive prompt and hangs until timeout.
  const realPlatform = process.platform;
  const setPlatform = (p: NodeJS.Platform) =>
    Object.defineProperty(process, "platform", { value: p, configurable: true });
  afterEach(() => setPlatform(realPlatform));

  test("win32 + cmd.exe shell → /c, not -c", () => {
    setPlatform("win32");
    const t = resolveSpawnTarget("echo hi", {
      cwd: "C:\\tmp",
      shell: "C:\\Windows\\system32\\cmd.exe",
      sandbox: createOffBackend(),
    });
    expect(t.file).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(t.args).toEqual(["/c", "echo hi"]);
  });

  test("win32 + pwsh shell → -Command", () => {
    setPlatform("win32");
    const t = createOffBackend().wrap("gci", { cwd: "C:\\tmp", shell: "pwsh.exe" });
    expect(t.file).toBe("pwsh.exe");
    expect(t.args).toEqual(["-Command", "gci"]);
  });

  test("win32 + Git Bash shell → -c, not /c", () => {
    setPlatform("win32");
    const t = createOffBackend().wrap("ls -la", {
      cwd: "C:\\tmp",
      shell: "C:\\Program Files\\Git\\bin\\bash.exe",
    });
    expect(t.file).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(t.args).toEqual(["-c", "ls -la"]);
  });
});

describe("Windows shell invocation", () => {
  const realPlatform = process.platform;
  const setPlatform = (p: NodeJS.Platform) =>
    Object.defineProperty(process, "platform", { value: p, configurable: true });
  afterEach(() => setPlatform(realPlatform));

  test("explicit PowerShell uses -Command", () => {
    setPlatform("win32");
    const t = resolveShellInvocation("Write-Output hi", "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    expect(t.file).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    expect(t.args).toEqual(["-Command", "Write-Output hi"]);
  });

  test("explicit cmd uses /c", () => {
    setPlatform("win32");
    const t = resolveShellInvocation("echo hi", "C:\\Windows\\System32\\cmd.exe");
    expect(t.file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(t.args).toEqual(["/c", "echo hi"]);
  });

  test("explicit Git Bash uses -c", () => {
    setPlatform("win32");
    const t = resolveShellInvocation("echo hi", "C:\\Program Files\\Git\\bin\\bash.exe");
    expect(t.file).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(t.args).toEqual(["-c", "echo hi"]);
  });
});

describe("buildSandboxEnv", () => {
  test("forwards allowlisted vars, drops secrets", () => {
    const env = buildSandboxEnv({
      PATH: "/usr/bin",
      HOME: "/home/me",
      OPENROUTER_API_KEY: "sk-secret",
      AWS_SECRET_ACCESS_KEY: "shh",
      RANDOM_VAR: "nope",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/me");
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.RANDOM_VAR).toBeUndefined();
  });

  test("deny regex catches KEY/TOKEN/SECRET even if allowlisted name", () => {
    expect(ENV_DENY_REGEX.test("PATH_TOKEN")).toBe(true);
    expect(ENV_DENY_REGEX.test("PATH")).toBe(false);
  });
});

describe("mergeShellEnv", () => {
  test("returns base unchanged when projectEnv is undefined or empty", () => {
    const base = { PATH: "/usr/bin" };
    expect(mergeShellEnv(base, undefined)).toBe(base);
    expect(mergeShellEnv(base, {})).toBe(base);
  });

  test("layers project values on top of base", () => {
    const env = mergeShellEnv({ PATH: "/usr/bin", HOME: "/home/me" }, {
      DATABASE_URL: "postgres://local",
      NODE_ENV: "test",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/me");
    expect(env.DATABASE_URL).toBe("postgres://local");
    expect(env.NODE_ENV).toBe("test");
  });

  test("project value overrides a base value of the same name", () => {
    const env = mergeShellEnv({ NODE_ENV: "development" }, { NODE_ENV: "production" });
    expect(env.NODE_ENV).toBe("production");
  });

  test("bypasses the deny regex — user-configured secrets ARE honored", () => {
    // The deny regex protects the HOST's env from a tainted model; values the
    // user typed into project settings are a different trust class.
    const env = mergeShellEnv(buildSandboxEnv({ PATH: "/usr/bin" }), {
      MY_API_TOKEN: "user-put-this-here",
    });
    expect(env.MY_API_TOKEN).toBe("user-put-this-here");
  });

  test("does not mutate the base object", () => {
    const base = { PATH: "/usr/bin" };
    mergeShellEnv(base, { FOO: "bar" });
    expect(base).toEqual({ PATH: "/usr/bin" });
  });
});

describe("killProcessGroup", () => {
  test("kills a process and its forked child (whole group)", async () => {
    const sh = testShPath();
    if (!sh) return;
    // A command that forks a child sleeper into the same process group.
    // If we only killed the outer sh, the inner sleep would survive.
    const child = spawn(
      sh,
      ["-c", "sleep 30 & sleep 30 & wait"],
      { detached: true, stdio: "ignore" },
    );
    // Wait for the process to actually start.
    await new Promise((r) => setTimeout(r, 200));
    const pid = child.pid!;
    expect(pid).toBeGreaterThan(0);

    await killProcessGroup(pid, { graceMs: 300 });

    // After kill, the process group should be gone. process.kill(-pgid, 0)
    // throws ESRCH when no process in the group remains.
    await new Promise((r) => setTimeout(r, 100));
    let groupAlive = true;
    try {
      process.kill(-pid, 0);
    } catch (e) {
      groupAlive = (e as NodeJS.ErrnoException).code !== "ESRCH";
    }
    expect(groupAlive).toBe(false);
  });

  test("idempotent on an already-dead group (no throw)", async () => {
    const sh = testShPath();
    if (!sh) return;
    const child = spawn(sh, ["-c", "true"], { detached: true, stdio: "ignore" });
    const pid = child.pid!;
    await new Promise((r) => setTimeout(r, 100));
    // Should not throw even though the group is already gone.
    await killProcessGroup(pid, { graceMs: 100 });
    expect(true).toBe(true);
  });

  test("REFUSES a bogus pgid (0/1/negative/NaN) — never signals the caller's own group or -1", async () => {
    // The catastrophe guard: process.kill(-0) hits our OWN group, kill(-1) hits
    // EVERY process. A corrupt orphan record could surface 0/1; these must no-op.
    // We assert by side effect: this test process must survive all of them.
    for (const bogus of [0, 1, -5, NaN, 1.5]) {
      await killProcessGroup(bogus, { graceMs: 50 }); // must resolve, not signal
      expect(groupAlive(bogus)).toBe(false); // bogus pgid is never "alive"
    }
    // If a real signal had been fired at our own group, the runner would be dead;
    // reaching here proves the guard held.
    expect(process.pid).toBeGreaterThan(1);
  });
});
