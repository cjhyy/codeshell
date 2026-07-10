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
  const fetchFn = options.fetch ?? fetch;
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

  const res = await (options.fetch ?? fetch)(config.tokenEndpoint, {
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
