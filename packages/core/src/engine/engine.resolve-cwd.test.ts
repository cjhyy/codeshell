import { describe, test, expect } from "bun:test";
import { resolveRunCwd } from "./engine.js";

/**
 * cwd-resolution precedence for engine.run. The bug this guards: a session
 * bound to a project (state.cwd = the repo) was resumed by a host that omitted
 * options.cwd (its sidebar repo selection had drifted to null), so cwd fell
 * straight through to process.cwd() and the engine loaded the WRONG project's
 * agents/settings/memory — a project-defined `director` agent vanished from the
 * registry. Fix: when the caller gives no cwd, recover it from the resumed
 * session's state.cwd BEFORE falling back to config/process cwd.
 *
 * Precedence: options.cwd > resumed session's state.cwd > config.cwd > process.cwd()
 */
describe("resolveRunCwd", () => {
  const PROC = "/proc/cwd";

  test("explicit options.cwd wins over everything", () => {
    expect(
      resolveRunCwd({ optionCwd: "/opt", sessionCwd: "/sess", configCwd: "/cfg", processCwd: PROC }),
    ).toBe("/opt");
  });

  test("falls back to the resumed session's cwd when caller omits one", () => {
    expect(
      resolveRunCwd({ optionCwd: undefined, sessionCwd: "/sess", configCwd: "/cfg", processCwd: PROC }),
    ).toBe("/sess");
  });

  test("session cwd outranks config cwd (a bound session beats the engine default)", () => {
    expect(
      resolveRunCwd({ optionCwd: undefined, sessionCwd: "/sess", configCwd: "/cfg", processCwd: PROC }),
    ).toBe("/sess");
  });

  test("falls back to config cwd when there is no session cwd", () => {
    expect(
      resolveRunCwd({ optionCwd: undefined, sessionCwd: undefined, configCwd: "/cfg", processCwd: PROC }),
    ).toBe("/cfg");
  });

  test("falls back to process cwd when nothing else is available", () => {
    expect(
      resolveRunCwd({ optionCwd: undefined, sessionCwd: undefined, configCwd: undefined, processCwd: PROC }),
    ).toBe(PROC);
  });
});
