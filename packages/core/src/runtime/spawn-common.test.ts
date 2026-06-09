import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { resolveSpawnTarget, killProcessGroup, buildSandboxEnv, mergeShellEnv, ENV_DENY_REGEX } from "./spawn-common.js";
import { createOffBackend } from "../tool-system/sandbox/off.js";

describe("resolveSpawnTarget", () => {
  test("no sandbox → shell -c command", () => {
    const t = resolveSpawnTarget("echo hi", { cwd: "/tmp", shell: "/bin/bash" });
    expect(t.file).toBe("/bin/bash");
    expect(t.args).toEqual(["-c", "echo hi"]);
    expect(t.cleanup).toBeUndefined();
  });

  test("off backend → delegates to backend.wrap", () => {
    const t = resolveSpawnTarget("echo hi", {
      cwd: "/tmp",
      shell: "/bin/zsh",
      sandbox: createOffBackend(),
    });
    expect(t.file).toBe("/bin/zsh");
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
    // A command that forks a child sleeper into the same process group.
    // If we only killed the outer sh, the inner sleep would survive.
    const child = spawn(
      "/bin/sh",
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
    const child = spawn("/bin/sh", ["-c", "true"], { detached: true, stdio: "ignore" });
    const pid = child.pid!;
    await new Promise((r) => setTimeout(r, 100));
    // Should not throw even though the group is already gone.
    await killProcessGroup(pid, { graceMs: 100 });
    expect(true).toBe(true);
  });
});
