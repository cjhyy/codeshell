import { describe, test, expect } from "bun:test";
import { nonInteractiveGitEnv } from "./gitOps.js";

// Regression: gitClone/gitFetchAndReset forwarded process.env raw, with no
// GIT_TERMINAL_PROMPT=0 or SSH batch mode. In the Electron main process (no
// TTY) a private/auth-required clone or an unknown SSH host key made git block
// on an interactive credential/host-key prompt — the install "hung" until the
// 60s timeout (or an off-screen askpass dialog). nonInteractiveGitEnv forces
// git to fail fast instead of prompting.

describe("nonInteractiveGitEnv", () => {
  test("disables git's interactive terminal prompt", () => {
    const env = nonInteractiveGitEnv({});
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  test("puts ssh in batch mode (no host-key / password prompt)", () => {
    const env = nonInteractiveGitEnv({});
    expect(env.GIT_SSH_COMMAND).toContain("BatchMode=yes");
  });

  test("preserves the caller's existing env", () => {
    const env = nonInteractiveGitEnv({ PATH: "/usr/bin", HOME: "/home/x" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/x");
  });

  test("does not clobber a caller-provided GIT_SSH_COMMAND", () => {
    const env = nonInteractiveGitEnv({ GIT_SSH_COMMAND: "ssh -i /my/key" });
    expect(env.GIT_SSH_COMMAND).toBe("ssh -i /my/key");
    // but still forces the prompt off
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });
});
