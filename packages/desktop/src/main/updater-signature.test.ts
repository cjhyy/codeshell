import { describe, expect, test } from "bun:test";
import { macSignatureNeedsManualInstall, releaseUrlForVersion } from "./updater-signature";

describe("updater signature helpers", () => {
  test("detects ad-hoc macOS signatures that cannot pass Squirrel update validation", () => {
    const text = [
      "Executable=/Applications/code-shell.app/Contents/MacOS/code-shell",
      "Signature=adhoc",
      "TeamIdentifier=not set",
      '# designated => cdhash H"be49b25486a4e4934fdac08965f4f2d43bfdb253"',
    ].join("\n");

    expect(macSignatureNeedsManualInstall(text)).toBe(true);
  });

  test("does not flag Developer ID signatures", () => {
    const text = [
      "Executable=/Applications/code-shell.app/Contents/MacOS/code-shell",
      "Authority=Developer ID Application: Example Inc (TEAM123456)",
      "TeamIdentifier=TEAM123456",
      'designated => identifier "com.cjhyy.codeshell" and anchor apple generic',
    ].join("\n");

    expect(macSignatureNeedsManualInstall(text)).toBe(false);
  });

  test("does not flag the stable ad-hoc requirement used for unsigned mac updater builds", () => {
    const text = [
      "Executable=/Applications/code-shell.app/Contents/MacOS/code-shell",
      "Signature=adhoc",
      "TeamIdentifier=not set",
      'designated => identifier "com.cjhyy.codeshell"',
    ].join("\n");

    expect(macSignatureNeedsManualInstall(text)).toBe(false);
  });

  test("builds release URLs from semver or tag versions", () => {
    expect(releaseUrlForVersion("0.6.0-rc.5")).toBe(
      "https://github.com/cjhyy/codeshell/releases/tag/v0.6.0-rc.5",
    );
    expect(releaseUrlForVersion("v0.6.0")).toBe(
      "https://github.com/cjhyy/codeshell/releases/tag/v0.6.0",
    );
  });
});
