import { describe, expect, test } from "bun:test";
import {
  isOAuthAccessTokenExpired,
  oauthCredentialStatus,
  parseOAuthCredentialSecret,
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
});
