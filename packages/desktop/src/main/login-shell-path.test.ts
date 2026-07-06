import { describe, expect, test } from "bun:test";
import { mergeLoginShellPath, parseEnvPathOutput, resolveLoginShell } from "./login-shell-path.js";

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
