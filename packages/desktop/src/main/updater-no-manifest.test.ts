import { describe, expect, test } from "bun:test";
import { isNoUpdateManifestError, isUpdateFeedConnectivityError } from "./updater-error-classify";

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

describe("isUpdateFeedConnectivityError", () => {
  test("matches common GitHub-unreachable network failures", () => {
    expect(isUpdateFeedConnectivityError("getaddrinfo ENOTFOUND github.com")).toBe(true);
    expect(isUpdateFeedConnectivityError("connect ETIMEDOUT 20.205.243.166:443")).toBe(true);
    expect(isUpdateFeedConnectivityError("net::ERR_CONNECTION_TIMED_OUT")).toBe(true);
    expect(isUpdateFeedConnectivityError("Connection error.")).toBe(true);
  });

  test("does not hide HTTP, authentication, or updater configuration errors", () => {
    expect(isUpdateFeedConnectivityError("HttpError: 401 Unauthorized")).toBe(false);
    expect(isUpdateFeedConnectivityError("HttpError: 403 Forbidden")).toBe(false);
    expect(isUpdateFeedConnectivityError("Cannot find latest-mac.yml: HttpError: 404")).toBe(false);
    expect(isUpdateFeedConnectivityError("auto-update only runs in packaged builds")).toBe(false);
  });
});
