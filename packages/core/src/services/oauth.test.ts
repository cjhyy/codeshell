import { describe, expect, test } from "bun:test";
import { authorize, createHardenedOAuthFetch } from "./oauth.js";

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
        fetch: (async (input, init) => {
          exchangeBody = await new Request(input, init).text();
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
          openExternal: async (url) => {
            await callbackFromAuthorizationUrl(url, { code: "code", state: "bad" });
          },
          fetch: (async () => {
            exchanges++;
            return Response.json({ access_token: "never" });
          }) as unknown as typeof fetch,
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
          openExternal: async (url) => {
            await callbackFromAuthorizationUrl(url, { error: "access_denied" });
          },
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

describe("hardened OAuth fetch redirects", () => {
  for (const status of [302, 307, 308]) {
    test(`does not forward a secret-bearing POST across origins after ${status}`, async () => {
      const calls: Array<{ url: string; body: string }> = [];
      const baseFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input as unknown as string, init);
        calls.push({ url: request.url, body: await request.text() });
        if (request.url === "https://auth.example/token") {
          return new Response(null, {
            status,
            headers: { Location: "https://attacker.example/collect" },
          });
        }
        return new Response("unexpected", { status: 500 });
      }) as unknown as typeof fetch;
      const hardened = createHardenedOAuthFetch(baseFetch);

      await expect(
        hardened("https://auth.example/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "refresh_token=sentinel-refresh&client_secret=sentinel-client-secret",
        }),
      ).rejects.toThrow(/cross-origin redirect/);

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://auth.example/token");
      expect(calls.some((call) => call.url.includes("attacker.example"))).toBe(false);
    });
  }

  test("rejects redirects to HTTP, loopback, and private network targets before fetching them", async () => {
    for (const target of [
      "http://attacker.example/metadata",
      "https://127.0.0.1/private",
      "https://10.0.0.8/private",
    ]) {
      const calls: string[] = [];
      const hardened = createHardenedOAuthFetch((async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const request = new Request(input as unknown as string, init);
        calls.push(request.url);
        return new Response(null, { status: 302, headers: { Location: target } });
      }) as unknown as typeof fetch);

      await expect(hardened("https://auth.example/.well-known/oauth")).rejects.toThrow();
      expect(calls).toEqual(["https://auth.example/.well-known/oauth"]);
    }
  });

  test("follows a bounded same-origin redirect while preserving a POST body", async () => {
    const calls: Array<{ url: string; body: string; redirect: Request["redirect"] }> = [];
    const hardened = createHardenedOAuthFetch((async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const request = new Request(input as unknown as string, init);
      calls.push({ url: request.url, body: await request.text(), redirect: request.redirect });
      if (new URL(request.url).pathname === "/token") {
        return new Response(null, { status: 308, headers: { Location: "/oauth/token" } });
      }
      return Response.json({ access_token: "ok" });
    }) as unknown as typeof fetch);

    const response = await hardened("https://auth.example/token", {
      method: "POST",
      body: "code=sentinel-code",
    });

    expect(response.ok).toBe(true);
    expect(calls).toEqual([
      {
        url: "https://auth.example/token",
        body: "code=sentinel-code",
        redirect: "manual",
      },
      {
        url: "https://auth.example/oauth/token",
        body: "code=sentinel-code",
        redirect: "manual",
      },
    ]);
  });

  test("stops after the configured redirect limit", async () => {
    const calls: string[] = [];
    const hardened = createHardenedOAuthFetch(
      (async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input as unknown as string, init);
        calls.push(request.url);
        const step = Number(new URL(request.url).searchParams.get("step") ?? "0");
        return new Response(null, {
          status: 302,
          headers: { Location: `https://auth.example/discovery?step=${step + 1}` },
        });
      }) as unknown as typeof fetch,
      { maxRedirects: 1 },
    );

    await expect(hardened("https://auth.example/discovery?step=0")).rejects.toThrow(
      /redirect limit/,
    );
    expect(calls).toHaveLength(2);
  });
});
