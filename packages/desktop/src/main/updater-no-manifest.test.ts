import { describe, expect, test } from "bun:test";
import { isNoUpdateManifestError, isUpdateFeedConnectivityError } from "./updater-error-classify";

describe("isNoUpdateManifestError", () => {
  test("matches the real GitHub 404 HttpError from a not-yet-published release", () => {
    const msg =
      "Cannot find latest-mac.yml in the latest release artifacts " +
      "(https://github.com/cjhyy/codeshell/releases/download/v0.6.0-rc.11/latest-mac.yml): " +
      'HttpError: 404 "method: GET url: ..."';
    expect(isNoUpdateManifestError(msg)).toBe(true);
  });

  test("matches a bare 404", () => {
    expect(isNoUpdateManifestError("HttpError: 404")).toBe(true);
    expect(isNoUpdateManifestError("404 Not Found\nGET /latest-mac.yml")).toBe(true);
  });

  test("does NOT match a genuine failure (connection / auth)", () => {
    expect(isNoUpdateManifestError("Connection error.")).toBe(false);
    expect(isNoUpdateManifestError("ENOTFOUND github.com")).toBe(false);
    expect(isNoUpdateManifestError("write EPIPE")).toBe(false);
  });

  test("a manifest filename does not hide authentication, server or parse failures", () => {
    for (const message of [
      "HttpError: 401 Unauthorized; GET https://owned.invalid/latest-mac.yml",
      "HttpError: 403 Forbidden; GET https://owned.invalid/latest-linux.yml",
      "HttpError: 500 Internal Server Error; GET https://owned.invalid/latest.yml",
      "Cannot parse update info from latest-mac.yml: YAMLException: bad indentation",
      "getaddrinfo ENOTFOUND owned.invalid while fetching latest-mac.yml",
      "HttpError: 401 Unauthorized; GET https://owned.invalid/releases/v404/latest-mac.yml",
      "Cannot find channel configuration; HttpError: 403 Forbidden",
    ]) {
      expect(isNoUpdateManifestError(message)).toBe(false);
    }
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
