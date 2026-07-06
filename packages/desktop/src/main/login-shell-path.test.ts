import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  injectLoginShellPathAtStartup,
  mergeLoginShellPath,
  parseEnvPathOutput,
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
        timeoutMs: 500,
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
});
