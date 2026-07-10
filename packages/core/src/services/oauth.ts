/** OAuth 2.0 authorization-code + PKCE primitives for host applications. */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mergeOAuthTokenResponse } from "../credentials/oauth.js";

export interface OAuthConfig {
  clientId: string;
  clientSecret?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  redirectUri?: string;
  scopes?: string[];
  resource?: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType: string;
  scope?: string;
}

export interface OAuthAuthorizeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  openExternal?: (url: string) => Promise<void> | void;
  fetch?: typeof fetch;
  callbackHost?: "127.0.0.1";
  /** Zero asks the OS for an ephemeral port. */
  callbackPort?: number;
}

export interface OAuthRefreshOptions {
  fetch?: typeof fetch;
  now?: number;
}

export interface HardenedOAuthFetchOptions {
  /** Maximum redirects followed after the initial request. */
  maxRedirects?: number;
}

const OAUTH_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function normalizedHostname(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

function ipv4Octets(hostname: string): number[] | undefined {
  const parts = normalizedHostname(hostname).split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined;
  const octets = parts.map(Number);
  return octets.every((part) => part >= 0 && part <= 255) ? octets : undefined;
}

function isLoopbackHostname(hostname: string): boolean {
  const host = normalizedHostname(hostname);
  const octets = ipv4Octets(host);
  return host === "localhost" || host === "::1" || Boolean(octets && octets[0] === 127);
}

function isPrivateNetworkHostname(hostname: string): boolean {
  const host = normalizedHostname(hostname);
  const octets = ipv4Octets(host);
  if (octets) {
    const [a, b] = octets;
    return (
      a === 0 ||
      a === 10 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (!host.includes(":")) return false;
  return host === "::" || host.startsWith("fc") || host.startsWith("fd") || /^fe[89ab]/.test(host);
}

function validateOAuthRequestUrl(url: URL): void {
  if (url.username || url.password) throw new Error("OAuth endpoint must not include credentials");
  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("OAuth endpoint must use HTTPS (HTTP is allowed only for localhost)");
  }
  if (!loopback && isPrivateNetworkHostname(url.hostname)) {
    throw new Error("OAuth endpoint must not target a private network address");
  }
}

/**
 * Wrap fetch with OAuth-specific redirect handling. Every hop is validated;
 * POST/Authorization requests never cross origins, so authorization codes,
 * verifiers, refresh tokens, client secrets, and revocation tokens cannot be
 * forwarded by an upstream 30x response.
 */
export function createHardenedOAuthFetch(
  baseFetch: typeof fetch = fetch,
  options: HardenedOAuthFetchOptions = {},
): typeof fetch {
  const maxRedirects = Math.max(0, Math.min(10, options.maxRedirects ?? 5));
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const initial = new Request(input, init);
    let currentUrl = new URL(initial.url);
    const initialLoopback = isLoopbackHostname(currentUrl.hostname);
    let method = initial.method.toUpperCase();
    let headers = new Headers(initial.headers);
    let body =
      method === "GET" || method === "HEAD"
        ? undefined
        : new Uint8Array(await initial.clone().arrayBuffer());
    const secretBearing = (method !== "GET" && method !== "HEAD") || headers.has("authorization");

    for (let redirectCount = 0; ; redirectCount++) {
      validateOAuthRequestUrl(currentUrl);
      const request = new Request(currentUrl, {
        method,
        headers,
        body: body ? body.slice() : undefined,
        redirect: "manual",
        signal: initial.signal,
      });
      const response = await baseFetch(request);
      if (!OAUTH_REDIRECT_STATUSES.has(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      if (redirectCount >= maxRedirects) throw new Error("OAuth redirect limit exceeded");

      const nextUrl = new URL(location, currentUrl);
      validateOAuthRequestUrl(nextUrl);
      if (!initialLoopback && isLoopbackHostname(nextUrl.hostname)) {
        throw new Error("OAuth redirect to a local network target is not allowed");
      }
      if (secretBearing && nextUrl.origin !== currentUrl.origin) {
        throw new Error("OAuth secret-bearing request refused a cross-origin redirect");
      }

      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === "POST")
      ) {
        method = "GET";
        body = undefined;
        headers = new Headers(headers);
        headers.delete("content-type");
        headers.delete("content-length");
      }
      currentUrl = nextUrl;
    }
  }) as typeof fetch;
}

export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function tokensFromSecret(secret: ReturnType<typeof mergeOAuthTokenResponse>): OAuthTokens {
  return {
    accessToken: secret.accessToken,
    refreshToken: secret.refreshToken,
    expiresAt: secret.expiresAt ? Date.parse(secret.expiresAt) : undefined,
    tokenType: secret.tokenType ?? "Bearer",
    scope: secret.scope,
  };
}

function callbackSettings(
  config: OAuthConfig,
  options: OAuthAuthorizeOptions,
): { host: "127.0.0.1"; port: number; path: string; fixedRedirect?: string } {
  const host = options.callbackHost ?? "127.0.0.1";
  if (!config.redirectUri) {
    return { host, port: options.callbackPort ?? 0, path: "/callback" };
  }
  const redirect = new URL(config.redirectUri);
  if (
    redirect.protocol !== "http:" ||
    (redirect.hostname !== "127.0.0.1" && redirect.hostname !== "localhost")
  ) {
    throw new Error("OAuth redirectUri must be an HTTP loopback URL");
  }
  const port = options.callbackPort ?? Number(redirect.port || "80");
  return {
    host,
    port,
    path: redirect.pathname || "/callback",
    fixedRedirect: options.callbackPort === undefined ? redirect.toString() : undefined,
  };
}

/**
 * Run an OAuth authorization-code flow. The host owns browser launching and
 * injects `openExternal`; core only listens on an ephemeral loopback port.
 */
export async function authorize(
  config: OAuthConfig,
  options: OAuthAuthorizeOptions = {},
): Promise<OAuthTokens> {
  if (options.signal?.aborted) throw new Error("OAuth authorization aborted");
  const callback = callbackSettings(config, options);
  const { verifier, challenge } = generatePKCE();
  const state = randomBytes(16).toString("hex");
  const fetchFn = createHardenedOAuthFetch(options.fetch ?? fetch);
  const openExternal = options.openExternal;
  if (!openExternal) throw new Error("OAuth authorize requires an openExternal host callback");

  return new Promise<OAuthTokens>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let redirectUri = "";

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (server.listening) server.close();
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const succeed = (tokens: OAuthTokens) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(tokens);
    };
    const onAbort = () => fail(new Error("OAuth authorization aborted"));

    const server: Server = createServer(async (req, res) => {
      const requestUrl = new URL(req.url ?? "/", redirectUri || "http://127.0.0.1");
      if (requestUrl.pathname !== callback.path) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const returnedState = requestUrl.searchParams.get("state");
      const code = requestUrl.searchParams.get("code");
      const oauthError = requestUrl.searchParams.get("error");
      if (returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>Invalid OAuth callback</h1><p>You can close this window.</p>");
        fail(new Error("Invalid OAuth callback: state mismatch"));
        return;
      }
      if (oauthError) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>Authorization was not completed</h1><p>You can close this window.</p>");
        fail(new Error(oauthError === "access_denied" ? "OAuth access denied" : "OAuth failed"));
        return;
      }
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>Invalid OAuth callback</h1><p>You can close this window.</p>");
        fail(new Error("Invalid OAuth callback: missing code"));
        return;
      }

      try {
        const tokenParams = new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: config.clientId,
          code_verifier: verifier,
        });
        if (config.clientSecret) tokenParams.set("client_secret", config.clientSecret);
        if (config.resource) tokenParams.set("resource", config.resource);
        const tokenRes = await fetchFn(config.tokenEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: tokenParams.toString(),
          signal: options.signal,
        });
        if (!tokenRes.ok) {
          throw new Error(`OAuth token exchange failed (${tokenRes.status})`);
        }
        const secret = mergeOAuthTokenResponse(
          undefined,
          (await tokenRes.json()) as Parameters<typeof mergeOAuthTokenResponse>[1],
        );
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>Authorization successful</h1><p>You can close this window.</p>");
        succeed(tokensFromSecret(secret));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>Token exchange failed</h1><p>You can close this window.</p>");
        fail(err);
      }
    });

    options.signal?.addEventListener("abort", onAbort, { once: true });
    server.once("error", (err) => fail(new Error(`OAuth callback server failed: ${err.message}`)));
    server.listen(callback.port, callback.host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        fail(new Error("OAuth callback server did not expose a loopback port"));
        return;
      }
      redirectUri =
        callback.fixedRedirect ?? `http://${callback.host}:${address.port}${callback.path}`;
      const authUrl = new URL(config.authorizationEndpoint);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", config.clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("code_challenge", challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      if (config.scopes?.length) authUrl.searchParams.set("scope", config.scopes.join(" "));
      if (config.resource) authUrl.searchParams.set("resource", config.resource);

      timer = setTimeout(
        () => fail(new Error("OAuth authorization timed out")),
        options.timeoutMs ?? 120_000,
      );
      Promise.resolve(openExternal(authUrl.toString())).catch(fail);
    });
  });
}

export async function refreshToken(
  config: OAuthConfig,
  refreshTokenValue: string,
  options: OAuthRefreshOptions = {},
): Promise<OAuthTokens> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.clientId,
    refresh_token: refreshTokenValue,
  });
  if (config.clientSecret) params.set("client_secret", config.clientSecret);
  if (config.scopes?.length) params.set("scope", config.scopes.join(" "));
  if (config.resource) params.set("resource", config.resource);

  const res = await createHardenedOAuthFetch(options.fetch ?? fetch)(config.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) throw new Error(`OAuth token refresh failed (${res.status})`);
  const secret = mergeOAuthTokenResponse(
    { accessToken: "replaced", refreshToken: refreshTokenValue },
    (await res.json()) as Parameters<typeof mergeOAuthTokenResponse>[1],
    { now: options.now },
  );
  return tokensFromSecret(secret);
}
