import { describe, expect, test } from "bun:test";
import { authorize } from "./oauth.js";

async function callbackFromAuthorizationUrl(
  authorizationUrl: string,
  params: Record<string, string>,
): Promise<Response> {
  const url = new URL(authorizationUrl);
  const redirect = new URL(url.searchParams.get("redirect_uri")!);
  for (const [key, value] of Object.entries(params)) redirect.searchParams.set(key, value);
  if (!redirect.searchParams.has("state")) {
    redirect.searchParams.set("state", url.searchParams.get("state")!);
  }
  return fetch(redirect);
}

describe("OAuth authorization code flow", () => {
  test("builds PKCE authorization URL, handles callback and validates token response", async () => {
    let opened = "";
    let exchangeBody = "";
    const pending = authorize(
      {
        clientId: "client-id",
        authorizationEndpoint: "https://auth.example/authorize?audience=existing",
        tokenEndpoint: "https://auth.example/token",
        scopes: ["read", "write"],
        resource: "https://mcp.example/",
      },
      {
        openExternal: async (url) => {
          opened = url;
          await callbackFromAuthorizationUrl(url, { code: "auth-code" });
        },
        fetch: (async (_url, init) => {
          exchangeBody = String(init?.body);
          return Response.json({
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_in: 120,
          });
        }) as typeof fetch,
      },
    );

    const tokens = await pending;
    const auth = new URL(opened);
    expect(auth.searchParams.get("audience")).toBe("existing");
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(auth.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(auth.searchParams.get("scope")).toBe("read write");
    expect(exchangeBody).toContain("code_verifier=");
    expect(exchangeBody).toContain("resource=https%3A%2F%2Fmcp.example%2F");
    expect(tokens).toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenType: "Bearer",
    });
  });

  test("rejects state mismatch and access denial without exchanging a token", async () => {
    let exchanges = 0;
    await expect(
      authorize(
        {
          clientId: "client",
          authorizationEndpoint: "https://auth.example/authorize",
          tokenEndpoint: "https://auth.example/token",
        },
        {
          openExternal: (url) => callbackFromAuthorizationUrl(url, { code: "code", state: "bad" }),
          fetch: (async () => {
            exchanges++;
            return Response.json({ access_token: "never" });
          }) as typeof fetch,
        },
      ),
    ).rejects.toThrow(/state mismatch/);
    await expect(
      authorize(
        {
          clientId: "client",
          authorizationEndpoint: "https://auth.example/authorize",
          tokenEndpoint: "https://auth.example/token",
        },
        {
          openExternal: (url) => callbackFromAuthorizationUrl(url, { error: "access_denied" }),
        },
      ),
    ).rejects.toThrow(/access denied/);
    expect(exchanges).toBe(0);
  });

  test("cleans up on timeout and AbortSignal", async () => {
    await expect(
      authorize(
        {
          clientId: "client",
          authorizationEndpoint: "https://auth.example/authorize",
          tokenEndpoint: "https://auth.example/token",
        },
        { openExternal: () => {}, timeoutMs: 10 },
      ),
    ).rejects.toThrow(/timed out/);

    const controller = new AbortController();
    const pending = authorize(
      {
        clientId: "client",
        authorizationEndpoint: "https://auth.example/authorize",
        tokenEndpoint: "https://auth.example/token",
      },
      { openExternal: () => controller.abort(), signal: controller.signal },
    );
    await expect(pending).rejects.toThrow(/aborted/);
  });
});
