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

  test("allows the release certificate requirement without an Apple team identifier", () => {
    const app = 'identifier "com.cjhyy.codeshell"';
    const leaf = 'certificate leaf = H"30a64d20fc3614e327902f45cf9b725e6e1986dc"';
    const inspect = (requirement: string) =>
      macSignatureNeedsManualInstall(`TeamIdentifier=not set\ndesignated => ${requirement}`);
    expect(inspect(`${app} and ${leaf}`)).toBe(false);
    expect(inspect(`${app} and ${leaf.replace("30a6", "c0de")}`)).toBe(true);
    expect(inspect(`${app.replace("codeshell", "other")} and ${leaf}`)).toBe(true);
    expect(inspect(`${app} and ${leaf} or true`)).toBe(true);
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
