import { describe, expect, it } from "bun:test";
import {
  codexArgsForTurn,
  sandboxForMode,
  codexStderrError,
  sealEventOnExit,
} from "./codex-room-agent.js";

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

describe("sealEventOnExit (#6 — never leave the room stuck on 'working')", () => {
  it("returns null on a clean exit that already sealed via turn.completed", () => {
    // turnSealed=true: a turn_end already fired from turn.completed JSON.
    expect(
      sealEventOnExit({ code: 0, signal: null, turnSealed: true, stopping: false, hasStderrError: false }),
    ).toBeNull();
  });

  it("returns null when the user stopped the room (not a crash)", () => {
    expect(
      sealEventOnExit({ code: null, signal: "SIGTERM", turnSealed: false, stopping: true, hasStderrError: false }),
    ).toBeNull();
  });

  it("returns null when a stderr error will already surface (avoid double-seal)", () => {
    // The exit handler emits an `error` event from codexStderrError; that error
    // already seals the run in the reducer, so don't also emit a turn_end.
    expect(
      sealEventOnExit({ code: 1, signal: null, turnSealed: false, stopping: false, hasStderrError: true }),
    ).toBeNull();
  });

  it("emits a fallback turn_end when the process dies non-zero with NO stderr and NO turn JSON", () => {
    // The bug: codex crashes / is OOM-killed mid-turn, produces no turn.completed
    // and no stderr — the room would hang on 'working' forever. We must seal it.
    const ev = sealEventOnExit({ code: 137, signal: null, turnSealed: false, stopping: false, hasStderrError: false });
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe("turn_end");
  });

  it("emits a fallback turn_end when the process is killed by a signal with no seal", () => {
    const ev = sealEventOnExit({ code: null, signal: "SIGKILL", turnSealed: false, stopping: false, hasStderrError: false });
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe("turn_end");
  });

  it("returns null on a clean (zero) exit even if the turn JSON was somehow missed", () => {
    // A zero exit means codex finished normally; even if we didn't see a
    // turn.completed line, don't manufacture a crash seal — but DO seal so the
    // UI doesn't hang. A turn_end with a benign reason is correct here.
    const ev = sealEventOnExit({ code: 0, signal: null, turnSealed: false, stopping: false, hasStderrError: false });
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe("turn_end");
  });
});
