import { describe, expect, it } from "bun:test";
import { codexArgsForTurn, sandboxForMode, codexStderrError } from "./codex-room-agent.js";

describe("sandboxForMode", () => {
  it("maps the three room permission modes to codex sandbox tiers", () => {
    expect(sandboxForMode("default")).toEqual({ bypass: false, sandbox: "read-only" });
    expect(sandboxForMode("acceptEdits")).toEqual({ bypass: false, sandbox: "workspace-write" });
    expect(sandboxForMode("bypassPermissions")).toEqual({ bypass: true, sandbox: undefined });
  });
});

describe("codexArgsForTurn", () => {
  it("starts fresh (no resume) when no thread id yet, prompt via stdin marker", () => {
    const args = codexArgsForTurn({ mode: "default", threadId: undefined });
    expect(args.slice(0, 4)).toEqual(["exec", "--json", "--color", "never"]);
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("--sandbox");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args).not.toContain("resume");
    expect(args[args.length - 1]).toBe("-");
  });

  it("resumes the captured thread id on a later turn", () => {
    const args = codexArgsForTurn({ mode: "acceptEdits", threadId: "T-123" });
    const i = args.indexOf("resume");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("T-123");
    expect(args[i + 2]).toBe("-");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("workspace-write");
  });

  it("uses bypass flag (no --sandbox) for bypassPermissions", () => {
    const args = codexArgsForTurn({ mode: "bypassPermissions", threadId: undefined });
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("--sandbox");
  });
});

describe("codexStderrError", () => {
  it("reports the accumulated stderr when the process exits non-zero", () => {
    // codex writes some failures (e.g. resume of a missing thread) ONLY to
    // stderr with no turn.failed JSON, so a non-zero exit must surface it.
    const lines = ["Error: thread/resume: no rollout found for thread id X (code -32600)"];
    expect(codexStderrError(lines, 1)).toBe(
      "Error: thread/resume: no rollout found for thread id X (code -32600)",
    );
  });

  it("returns null on a clean (zero) exit even if stderr mentioned 'error'", () => {
    // Non-fatal warnings ("...recovered from error", update notices) must NOT
    // become a red error in the room when the turn actually succeeded.
    const lines = ["warning: transient network error, retrying", "ok"];
    expect(codexStderrError(lines, 0)).toBeNull();
  });

  it("returns null on non-zero exit with no stderr (error already on stdout JSON)", () => {
    expect(codexStderrError([], 1)).toBeNull();
  });

  it("joins multiple stderr lines and trims, so a chunk split mid-line can't mangle it", () => {
    const lines = ["Error: something failed", "  caused by: downstream blew up"];
    expect(codexStderrError(lines, 1)).toBe(
      "Error: something failed\n  caused by: downstream blew up",
    );
  });
});
