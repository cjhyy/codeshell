import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { isTmuxControlMode, _resetTmuxControlModeProbeForTesting } from "./fullscreen.js";

// Regression: probeTmuxControlModeSync cached the env heuristic as the answer
// and bailed before the authoritative tmux probe in the ambiguous case
// (review-2026-05-30). Verify the deterministic branches; the spawn-probe path
// needs a real tmux server so isn't unit-tested here.

const KEYS = ["TMUX", "TERM_PROGRAM", "TERM"] as const;

describe("isTmuxControlMode", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    _resetTmuxControlModeProbeForTesting();
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetTmuxControlModeProbeForTesting();
  });

  test("false when not under tmux (no spawn, no heuristic match)", () => {
    delete process.env.TMUX;
    expect(isTmuxControlMode()).toBe(false);
  });

  test("true when the iTerm.app + non-screen TERM heuristic matches", () => {
    process.env.TMUX = "/tmp/tmux-1/default,1,0";
    process.env.TERM_PROGRAM = "iTerm.app";
    process.env.TERM = "xterm-256color";
    expect(isTmuxControlMode()).toBe(true);
  });

  test("regular tmux (TERM=screen) is NOT control mode via heuristic", () => {
    process.env.TMUX = "/tmp/tmux-1/default,1,0";
    process.env.TERM_PROGRAM = "tmux";
    process.env.TERM = "screen-256color";
    // Heuristic is false; not iTerm.app so the probe path may run, but with no
    // real tmux control-mode it resolves to false either way.
    expect(isTmuxControlMode()).toBe(false);
  });
});
