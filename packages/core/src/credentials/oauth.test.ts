import { describe, expect, test } from "bun:test";
import {
  isOAuthAccessTokenExpired,
  mergeOAuthTokenResponse,
  oauthCredentialStatus,
  parseOAuthCredentialSecret,
  shouldRefreshOAuthCredential,
} from "./oauth.js";

describe("OAuth credential secret schema", () => {
  test("parses the stored JSON shape", () => {
    const secret = parseOAuthCredentialSecret(
      JSON.stringify({
        version: 1,
        accessToken: "access-123",
        refreshToken: "refresh-123",
        expiresAt: "2030-01-01T00:00:00.000Z",
        tokenEndpoint: "https://auth.example.com/oauth/token",
        clientId: "client-abc",
        scope: "read write",
      }),
    );

    expect(secret.accessToken).toBe("access-123");
    expect(secret.refreshToken).toBe("refresh-123");
    expect(secret.expiresAt).toBe("2030-01-01T00:00:00.000Z");
    expect(secret.tokenEndpoint).toBe("https://auth.example.com/oauth/token");
    expect(secret.clientId).toBe("client-abc");
    expect(secret.scope).toBe("read write");
  });

  test("rejects malformed JSON and missing access tokens", () => {
    expect(() => parseOAuthCredentialSecret("not-json")).toThrow(/OAuth credential secret/);
    expect(() => parseOAuthCredentialSecret(JSON.stringify({ refreshToken: "r" }))).toThrow(
      /accessToken/,
    );
  });

  test("detects expired tokens with a refresh skew", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);

    expect(
      isOAuthAccessTokenExpired(
        { accessToken: "a", expiresAt: "2026-01-01T11:59:59.000Z" },
        { now, skewMs: 0 },
      ),
    ).toBe(true);

    expect(
      isOAuthAccessTokenExpired(
        { accessToken: "a", expiresAt: "2026-01-01T12:05:00.000Z" },
        { now, skewMs: 60_000 },
      ),
    ).toBe(false);

    expect(
      isOAuthAccessTokenExpired(
        { accessToken: "a", expiresAt: "2026-01-01T12:00:30.000Z" },
        { now, skewMs: 60_000 },
      ),
    ).toBe(true);
  });

  test("reports missing expiry as usable but unknown", () => {
    expect(oauthCredentialStatus({ accessToken: "a" }, { now: 0 })).toEqual({
      state: "valid",
      expiresAt: undefined,
      expiresInMs: undefined,
    });
  });

  test("merges rotation responses and preserves an omitted refresh token", () => {
    const previous = {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      tokenEndpoint: "https://auth.example/token",
      clientId: "client",
      scope: "read",
    };
    expect(
      mergeOAuthTokenResponse(
        previous,
        { access_token: "new-access", expires_in: 120, token_type: "Bearer" },
        { now: 1_000 },
      ),
    ).toMatchObject({
      accessToken: "new-access",
      refreshToken: "old-refresh",
      expiresAt: "1970-01-01T00:02:01.000Z",
      tokenEndpoint: "https://auth.example/token",
      clientId: "client",
      scope: "read",
    });
    expect(
      mergeOAuthTokenResponse(previous, {
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        scope: "read write",
      }),
    ).toMatchObject({
      refreshToken: "rotated-refresh",
      scope: "read write",
      scopes: ["read", "write"],
      expiresAt: undefined,
    });
  });

  test("rejects invalid token responses and unsupported token types", () => {
    expect(() => mergeOAuthTokenResponse(undefined, { access_token: "" })).toThrow(/access_token/);
    expect(() =>
      mergeOAuthTokenResponse(undefined, { access_token: "a", expires_in: Number.NaN }),
    ).toThrow(/expires_in/);
    expect(() => mergeOAuthTokenResponse(undefined, { access_token: "a", expires_in: -1 })).toThrow(
      /expires_in/,
    );
    expect(() =>
      mergeOAuthTokenResponse(undefined, { access_token: "a", token_type: "MAC" }),
    ).toThrow(/Bearer/);
    expect(() =>
      parseOAuthCredentialSecret(JSON.stringify({ accessToken: "a", tokenType: "MAC" })),
    ).toThrow(/Bearer/);
  });

  test("classifies the exact refresh-skew boundary and login-required state", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(
      shouldRefreshOAuthCredential(
        {
          accessToken: "a",
          refreshToken: "r",
          tokenEndpoint: "https://auth.example/token",
          expiresAt: "2026-01-01T12:01:00.000Z",
        },
        { now },
      ),
    ).toBe("refresh");
    expect(
      shouldRefreshOAuthCredential(
        { accessToken: "a", expiresAt: "2026-01-01T11:59:59.000Z" },
        { now },
      ),
    ).toBe("login_required");
    expect(shouldRefreshOAuthCredential({ accessToken: "a" }, { now })).toBe("no");
  });
});
