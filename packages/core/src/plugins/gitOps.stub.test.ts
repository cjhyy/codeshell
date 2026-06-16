import { describe, expect, test } from "bun:test";
import { isMissingDeveloperToolsStderr } from "./gitOps.js";

/**
 * On a fresh macOS without the Command Line Tools installed, `/usr/bin/git` is
 * an `xcrun` stub: it spawns successfully (so `isGitAvailable()` is fooled —
 * findExecutable sees the stub) but every invocation exits non-zero with an
 * xcrun error on stderr. We must classify that as GIT_NOT_FOUND so the host's
 * friendly "install Git" guidance fires, instead of leaking
 * `git clone ... exited 1: xcrun: error: ...` to the user.
 */
describe("isMissingDeveloperToolsStderr", () => {
  test("matches the xcrun CLT-missing stub output", () => {
    const stderr =
      "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), " +
      "missing xcrun at: /Library/Developer/CommandLineTools/usr/bin/xcrun";
    expect(isMissingDeveloperToolsStderr(stderr)).toBe(true);
  });

  test("matches the 'no developer tools' phrasing", () => {
    expect(isMissingDeveloperToolsStderr("xcrun: error: no developer tools were found")).toBe(true);
  });

  test("matches 'not a developer tool' phrasing", () => {
    expect(
      isMissingDeveloperToolsStderr("git is not a developer tool on the path"),
    ).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(isMissingDeveloperToolsStderr("XCRUN: ERROR: NO DEVELOPER TOOLS")).toBe(true);
  });

  test("does NOT match a real git error (auth/merge/etc)", () => {
    expect(isMissingDeveloperToolsStderr("fatal: Authentication failed for 'https://...'")).toBe(false);
    expect(isMissingDeveloperToolsStderr("error: pathspec 'main' did not match")).toBe(false);
    expect(isMissingDeveloperToolsStderr("")).toBe(false);
  });
});
