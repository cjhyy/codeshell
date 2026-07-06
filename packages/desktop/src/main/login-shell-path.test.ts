import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
