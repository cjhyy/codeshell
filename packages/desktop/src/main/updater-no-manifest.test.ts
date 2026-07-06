import { describe, expect, test } from "bun:test";
import { isNoUpdateManifestError } from "./updater-error-classify";

describe("isNoUpdateManifestError", () => {
  test("matches the real GitHub 404 HttpError from a not-yet-published release", () => {
    const msg =
      'Cannot find latest-mac.yml in the latest release artifacts ' +
      '(https://github.com/cjhyy/codeshell/releases/download/v0.6.0-rc.11/latest-mac.yml): ' +
      'HttpError: 404 "method: GET url: ..."';
    expect(isNoUpdateManifestError(msg)).toBe(true);
  });

  test("matches a bare 404", () => {
    expect(isNoUpdateManifestError("HttpError: 404")).toBe(true);
  });

  test("does NOT match a genuine failure (connection / auth)", () => {
    expect(isNoUpdateManifestError("Connection error.")).toBe(false);
    expect(isNoUpdateManifestError("ENOTFOUND github.com")).toBe(false);
    expect(isNoUpdateManifestError("write EPIPE")).toBe(false);
  });
});
