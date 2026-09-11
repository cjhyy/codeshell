import { describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  injectLoginShellPathAtStartup,
  mergeLoginShellEnv,
  mergeLoginShellPath,
  parseEnvPathOutput,
  parseLoginShellEnvOutput,
  resolveLoginShell,
} from "./login-shell-path.js";

describe("mergeLoginShellPath", () => {
  test("keeps existing order, prepends missing login-shell entries, and dedupes", () => {
    const existing = "/usr/bin:/bin:/custom/bin";
    const login = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/Users/me/.bun/bin";

    expect(mergeLoginShellPath(existing, login, ":")).toBe(
      "/opt/homebrew/bin:/usr/local/bin:/Users/me/.bun/bin:/usr/bin:/bin:/custom/bin",
    );
  });

  test("is idempotent when run repeatedly with the same login-shell PATH", () => {
    const login = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
    const once = mergeLoginShellPath("/usr/bin:/bin", login, ":");

    expect(mergeLoginShellPath(once, login, ":")).toBe(once);
  });

  test("leaves the current PATH intact when the shell probe returns no PATH", () => {
    expect(mergeLoginShellPath("/usr/bin:/bin", "", ":")).toBe("/usr/bin:/bin");
  });
});

describe("parseEnvPathOutput", () => {
  test("extracts PATH from noisy login-shell env output", () => {
    const output = [
      "profile banner",
      "SHELL=/bin/zsh",
      "PATH=/usr/bin:/bin",
      "PWD=/Users/me",
      "PATH=/opt/homebrew/bin:/usr/bin:/bin",
    ].join("\n");

    expect(parseEnvPathOutput(output)).toBe("/opt/homebrew/bin:/usr/bin:/bin");
  });
});

describe("parseLoginShellEnvOutput", () => {
  test("parses env output, preserves values containing equals, and skips malformed lines", () => {
    const output = [
      "PATH=/usr/bin:/bin",
      "NO_PROXY=localhost,127.0.0.1",
      "JAVA_HOME=/Library/Java=Current/Home",
      "profile banner",
      "BASH_FUNC_module%%=() {",
      "  echo ignored",
      "}",
      "1INVALID=value",
      "",
    ].join("\n");

    expect(parseLoginShellEnvOutput(output)).toEqual({
      PATH: "/usr/bin:/bin",
      NO_PROXY: "localhost,127.0.0.1",
      JAVA_HOME: "/Library/Java=Current/Home",
    });
  });
});

describe("mergeLoginShellEnv", () => {
  test("merges PATH with the existing PATH rules and injects allowed missing variables", () => {
    const current = { PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv;
    const snapshot = {
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      NVM_DIR: "/Users/me/.nvm",
      VOLTA_HOME: "/Users/me/.volta",
      HOMEBREW_PREFIX: "/opt/homebrew",
      MANPATH: "/opt/homebrew/share/man",
      LC_CTYPE: "UTF-8",
      LANGUAGE: "en_US",
      http_proxy: "http://127.0.0.1:8080",
    };

    expect(mergeLoginShellEnv(current, snapshot, ":")).toEqual({
      path: "/opt/homebrew/bin:/usr/bin:/bin",
      addedPathEntries: ["/opt/homebrew/bin"],
      addedEnv: {
        HOMEBREW_PREFIX: "/opt/homebrew",
        LANGUAGE: "en_US",
        LC_CTYPE: "UTF-8",
        MANPATH: "/opt/homebrew/share/man",
        NVM_DIR: "/Users/me/.nvm",
        VOLTA_HOME: "/Users/me/.volta",
        http_proxy: "http://127.0.0.1:8080",
      },
      addedEnvKeys: [
        "HOMEBREW_PREFIX",
        "LANGUAGE",
        "LC_CTYPE",
        "MANPATH",
        "NVM_DIR",
        "VOLTA_HOME",
        "http_proxy",
      ],
    });
  });

  test("keeps existing GUI values instead of overwriting from the login shell", () => {
    const current = {
      PATH: "/usr/bin:/bin",
      NVM_DIR: "/gui/.nvm",
      HTTP_PROXY: "",
    } as NodeJS.ProcessEnv;
    const snapshot = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      NVM_DIR: "/shell/.nvm",
      HTTP_PROXY: "http://127.0.0.1:8080",
      JAVA_HOME: "/Library/Java/Home",
    };

    expect(mergeLoginShellEnv(current, snapshot, ":")).toEqual({
      path: "/usr/local/bin:/usr/bin:/bin",
      addedPathEntries: ["/usr/local/bin"],
      addedEnv: {
        JAVA_HOME: "/Library/Java/Home",
      },
      addedEnvKeys: ["JAVA_HOME"],
    });
  });

  test("rejects denylisted and sensitive variables even when they look useful", () => {
    const current = { PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv;
    const snapshot = {
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      HOME: "/Users/me",
      USER: "me",
      LOGNAME: "me",
      SHELL: "/bin/zsh",
      PWD: "/Users/me/project",
      OLDPWD: "/Users/me",
      SHLVL: "2",
      _: "/usr/bin/env",
      TMPDIR: "/var/folders/tmp",
      SSH_AUTH_SOCK: "/private/tmp/ssh.sock",
      XPC_SERVICE_NAME: "application.com.cjhyy.codeshell",
      __CFBundleIdentifier: "com.cjhyy.codeshell",
      COMMAND_MODE: "unix2003",
      MallocNanoZone: "0",
      LC_AUTH: "secret",
      GITHUB_TOKEN: "secret",
      NPM_PASSWORD: "secret",
      PASSWD_FILE: "secret",
      SESSION_ID: "secret",
      COOKIE_JAR: "secret",
      PRIVATE_REGISTRY: "secret",
      HOMEBREW_PREFIX: "/opt/homebrew",
      LC_ALL: "en_US.UTF-8",
      PNPM_HOME: "/Users/me/Library/pnpm",
    };

    expect(mergeLoginShellEnv(current, snapshot, ":")).toEqual({
      path: "/opt/homebrew/bin:/usr/bin:/bin",
      addedPathEntries: ["/opt/homebrew/bin"],
      addedEnv: {
        HOMEBREW_PREFIX: "/opt/homebrew",
        LC_ALL: "en_US.UTF-8",
        PNPM_HOME: "/Users/me/Library/pnpm",
      },
      addedEnvKeys: ["HOMEBREW_PREFIX", "LC_ALL", "PNPM_HOME"],
    });
  });
});

describe("resolveLoginShell", () => {
  test("uses SHELL when set on macOS/Linux", () => {
    expect(resolveLoginShell({ SHELL: "/bin/fish" } as NodeJS.ProcessEnv, "darwin")).toBe(
      "/bin/fish",
    );
  });

  test("does not run on Windows", () => {
    expect(resolveLoginShell({ SHELL: "/bin/bash" } as NodeJS.ProcessEnv, "win32")).toBeNull();
  });
});

describe("injectLoginShellPathAtStartup logging", () => {
  test("a timeout kills only the probe group, including a child that ignores SIGTERM", async () => {
    const dir = mkdtempSync(join(tmpdir(), "login-shell-probe-group-"));
    const shell = join(dir, "slow-shell");
    const pidsFile = join(dir, "probe-pids.json");
    writeFileSync(
      shell,
      [
        "#!/bin/sh",
        "trap '' TERM",
        "/bin/sh -c 'trap \"\" TERM; while :; do /bin/sleep 1; done' &",
        'printf \'[%s,%s]\' "$$" "$!" > "$TEST_PIDS_FILE"',
        "wait",
      ].join("\n"),
      { mode: 0o755 },
    );
    const unrelated = spawn("/bin/sleep", ["30"], {
      stdio: "ignore",
    });
    let pids: number[] = [];
    const running = (pid: number): boolean => {
      try {
        // A terminated orphan can briefly remain a zombie until init reaps
        // it; it is no longer an executing startup-script process.
        const status = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
          encoding: "utf8",
        }).trim();
        return status.length > 0 && !status.startsWith("Z");
      } catch {
        return false;
      }
    };
    const waitUntil = async (ready: () => boolean) => {
      const deadline = Date.now() + 4_000;
      while (!ready() && Date.now() < deadline) await Bun.sleep(20);
      expect(ready()).toBe(true);
    };
    try {
      const startedAt = performance.now();
      const resultPromise = injectLoginShellPathAtStartup({
        env: {
          HOME: dir,
          SHELL: shell,
          PATH: "/usr/bin:/bin",
          TEST_PIDS_FILE: pidsFile,
        },
        platform: "darwin",
        timeoutMs: 3_000,
      });
      try {
        await waitUntil(() => existsSync(pidsFile));
      } catch {
        throw new Error(`probe fixture did not start: ${JSON.stringify(await resultPromise)}`);
      }
      pids = JSON.parse(readFileSync(pidsFile, "utf8")) as number[];
      expect(pids).toHaveLength(2);
      expect(pids.every((pid) => pid > 1 && pid !== process.pid)).toBe(true);
      const result = await resultPromise;
      expect(result.status).not.toBe("skipped");
      if (result.status === "skipped") throw new Error("expected a shell probe");
      expect(result.probe).toMatchObject({ ok: false, reason: "timeout" });
      expect(performance.now() - startedAt).toBeLessThan(4_500);
      await waitUntil(() => pids.every((pid) => !running(pid)));
      expect(unrelated.pid).toBeDefined();
      expect(running(unrelated.pid!)).toBe(true);
    } finally {
      if (pids.length === 0 && existsSync(pidsFile)) {
        pids = JSON.parse(readFileSync(pidsFile, "utf8")) as number[];
      }
      // This pid came only from the fixture spawned into its own group.
      if (pids[0] > 1 && pids[0] !== process.pid) {
        try {
          process.kill(-pids[0], "SIGKILL");
        } catch {
          // Expected once the probe's timeout cleanup has completed.
        }
      }
      unrelated.kill("SIGKILL");
      if (unrelated.exitCode === null && unrelated.signalCode === null) {
        await new Promise<void>((resolve) => unrelated.once("exit", () => resolve()));
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  test("can spawn an installed CLI after a login shell times out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "login-shell-timeout-"));
    const localBin = join(dir, ".local/bin");
    const shell = join(dir, "slow-shell");
    mkdirSync(localBin, { recursive: true });
    writeFileSync(shell, "#!/bin/sh\nexec /bin/sleep 10\n", { mode: 0o755 });
    writeFileSync(join(localBin, "codex"), "#!/bin/sh\nprintf 'codex-ready'\n", { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { HOME: dir, SHELL: shell, PATH: "/usr/bin:/bin" };
    const logs: string[] = [];
    try {
      const result = await injectLoginShellPathAtStartup({
        env,
        platform: "darwin",
        timeoutMs: 30,
        log: (event) => logs.push(event),
      });
      expect(result.status).toBe("updated");
      if (result.status !== "updated") throw new Error("expected fallback PATH");
      expect(result.probe).toMatchObject({ ok: false, reason: "timeout" });
      expect(result.added).toContain(localBin);
      expect(result.addedEnvKeys).toEqual([]);
      expect(env.PATH?.startsWith("/usr/bin:/bin:")).toBe(true);
      expect(env.PATH?.split(":")).not.toContain(join(dir, ".bun/bin"));
      expect(execFileSync("codex", ["--version"], { env, encoding: "utf-8" })).toBe("codex-ready");
      expect(logs).toContain("login-shell-path.fallback");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fallback keeps inherited executable precedence and is idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "login-shell-fallback-"));
    const inheritedBin = join(dir, "preferred/bin");
    const localBin = join(dir, ".local/bin");
    for (const [bin, text] of [
      [inheritedBin, "preferred"],
      [localBin, "fallback"],
    ]) {
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "codex"), `#!/bin/sh\nprintf '${text}'\n`, { mode: 0o755 });
    }
    const env: NodeJS.ProcessEnv = {
      HOME: dir,
      SHELL: join(dir, "missing-shell"),
      PATH: `${inheritedBin}:/usr/bin:/bin`,
      NO_PROXY: "keep-existing",
    };
    try {
      await injectLoginShellPathAtStartup({ env, platform: "linux" });
      const firstPath = env.PATH;
      const second = await injectLoginShellPathAtStartup({ env, platform: "linux" });
      expect(second.status).toBe("unchanged");
      expect(env.PATH).toBe(firstPath);
      expect(execFileSync("codex", [], { env, encoding: "utf-8" })).toBe("preferred");
      expect(env.NO_PROXY).toBe("keep-existing");
      expect(env.PATH?.split(":").filter((entry) => entry === localBin)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not add Unix fallback directories on Windows", async () => {
    const env = { PATH: "C:\\Windows", SHELL: "/missing-shell" };
    const result = await injectLoginShellPathAtStartup({ env, platform: "win32" });
    expect(result.status).toBe("skipped");
    expect(env.PATH).toBe("C:\\Windows");
  });

  test("does not log raw shell stderr on probe failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "login-shell-path-"));
    const shell = join(dir, "fake-shell.sh");
    writeFileSync(
      shell,
      "#!/bin/sh\nprintf 'startup secret: TOKEN=super-secret-value\\n' >&2\nexit 1\n",
      "utf-8",
    );
    chmodSync(shell, 0o755);
    const logs: Array<{ event: string; data?: Record<string, unknown> }> = [];

    try {
      await injectLoginShellPathAtStartup({
        env: { SHELL: shell, PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv,
        platform: "darwin",
        timeoutMs: 3_000,
        log: (event, data) => logs.push({ event, data }),
      });

      const failed = logs.find((entry) => entry.event === "login-shell-path.failed");
      expect(failed).toBeDefined();
      expect(JSON.stringify(failed?.data)).not.toContain("super-secret-value");
      expect(failed?.data).not.toHaveProperty("stderr");
      expect(failed?.data?.stderrRedacted).toBe(true);
      expect(typeof failed?.data?.stderrLength).toBe("number");
      expect(failed?.data).toMatchObject({ phase: "startup", timeoutMs: 3_000 });
      expect(typeof failed?.data?.elapsedMs).toBe("number");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retry diagnostics identify the phase and bound launch metadata", async () => {
    const logs: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const shell = `/missing-shell/${"a".repeat(1_000)}`;
    await injectLoginShellPathAtStartup({
      env: { HOME: "/missing-home", SHELL: shell, PATH: "/usr/bin:/bin" },
      platform: "darwin",
      phase: "runtime-retry",
      timeoutMs: 100,
      log: (event, data) => logs.push({ event, data }),
    });
    const failed = logs.find((entry) => entry.event === "login-shell-path.failed");
    expect(failed?.data).toMatchObject({ phase: "runtime-retry", timeoutMs: 100 });
    expect(Number(failed?.data?.elapsedMs)).toBeGreaterThanOrEqual(0);
    expect(String(failed?.data?.shell).length).toBeLessThanOrEqual(300);
    expect(String(failed?.data?.error).length).toBeLessThanOrEqual(300);
    expect(failed?.data).not.toHaveProperty("env");
    expect(failed?.data).not.toHaveProperty("PATH");
  });

  test("injects safe login-shell env keys and is idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "login-shell-env-"));
    const shell = join(dir, "fake-shell.sh");
    writeFileSync(
      shell,
      [
        "#!/bin/sh",
        "printf 'PATH=/opt/homebrew/bin:/usr/bin:/bin\\n'",
        "printf 'NVM_DIR=/Users/me/.nvm\\n'",
        "printf 'NO_PROXY=localhost,127.0.0.1\\n'",
        "printf 'GITHUB_TOKEN=super-secret-value\\n'",
        "printf 'HOME=/Users/me\\n'",
        "exit 0",
      ].join("\n"),
      "utf-8",
    );
    chmodSync(shell, 0o755);
    const env = { SHELL: shell, PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv;
    const logs: Array<{ event: string; data?: Record<string, unknown> }> = [];

    try {
      const first = await injectLoginShellPathAtStartup({
        env,
        platform: "darwin",
        timeoutMs: 3_000,
        log: (event, data) => logs.push({ event, data }),
      });
      const second = await injectLoginShellPathAtStartup({
        env,
        platform: "darwin",
        timeoutMs: 3_000,
        log: (event, data) => logs.push({ event, data }),
      });

      expect(first.status).toBe("updated");
      expect(first.addedEnvKeys).toEqual(["NO_PROXY", "NVM_DIR"]);
      expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin");
      expect(env.NVM_DIR).toBe("/Users/me/.nvm");
      expect(env.NO_PROXY).toBe("localhost,127.0.0.1");
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.HOME).toBeUndefined();
      expect(second.status).toBe("unchanged");
      expect(second.addedEnvKeys).toEqual([]);

      const updated = logs.find((entry) => entry.event === "login-shell-path.updated");
      expect(updated?.data?.addedEnvKeys).toEqual(["NO_PROXY", "NVM_DIR"]);
      expect(updated?.data?.pathChanged).toBe(true);
      expect(updated?.data?.addedPathEntryCount).toBe(1);
      expect(updated?.data).not.toHaveProperty("before");
      expect(updated?.data).not.toHaveProperty("after");
      expect(JSON.stringify(updated?.data)).not.toContain("super-secret-value");
      expect(JSON.stringify(updated?.data)).not.toContain("/Users/me/.nvm");
      expect(JSON.stringify(updated?.data)).not.toContain("localhost,127.0.0.1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
