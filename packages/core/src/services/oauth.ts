/**
 * OAuth service — OAuth 2.0 authorization code flow with PKCE.
 *
 * Supports browser-based login flow for API authentication.
 */

import { createServer, type Server } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { exec } from "node:child_process";

export interface OAuthConfig {
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  redirectUri?: string;
  scopes?: string[];
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType: string;
}

/**
 * Generate PKCE code verifier and challenge.
 */
function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * Open a URL in the system browser.
 */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

/**
 * Run the OAuth authorization code flow.
 * Opens a browser for user login and waits for the callback.
 */
export async function authorize(config: OAuthConfig): Promise<OAuthTokens> {
  const { verifier, challenge } = generatePKCE();
  const state = randomBytes(16).toString("hex");
  const port = 18910 + Math.floor(Math.random() * 100);
  const redirectUri = config.redirectUri ?? `http://localhost:${port}/callback`;

  // Build authorization URL
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  if (config.scopes?.length) {
    params.set("scope", config.scopes.join(" "));
  }

  const authUrl = `${config.authorizationEndpoint}?${params.toString()}`;

  return new Promise<OAuthTokens>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("OAuth authorization timed out (120s)"));
    }, 120_000);

    const server: Server = createServer(async (req, res) => {
      if (!req.url?.startsWith("/callback")) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const url = new URL(req.url, `http://localhost:${port}`);
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      clearTimeout(timeout);

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Authorization failed</h1><p>You can close this window.</p></body></html>");
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code || returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Invalid callback</h1></body></html>");
        server.close();
        reject(new Error("Invalid OAuth callback: missing code or state mismatch"));
        return;
      }

      // Exchange code for tokens
      try {
        const tokenParams = new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: config.clientId,
          code_verifier: verifier,
        });

        const tokenRes = await fetch(config.tokenEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: tokenParams.toString(),
        });

        if (!tokenRes.ok) {
          throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
        }

        const data = (await tokenRes.json()) as Record<string, unknown>;

        const tokens: OAuthTokens = {
          accessToken: data.access_token as string,
          refreshToken: data.refresh_token as string | undefined,
          expiresAt: data.expires_in
            ? Date.now() + (data.expires_in as number) * 1000
            : undefined,
          tokenType: (data.token_type as string) ?? "Bearer",
        };

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Authorization successful!</h1><p>You can close this window.</p></body></html>");
        server.close();
        resolve(tokens);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Token exchange failed</h1></body></html>");
        server.close();
        reject(err);
      }
    });

    server.listen(port, () => {
      openBrowser(authUrl);
    });

    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`OAuth server error: ${err.message}`));
    });
  });
}

/**
 * Refresh an access token using a refresh token.
 */
export async function refreshToken(
  config: OAuthConfig,
  refreshTokenValue: string,
): Promise<OAuthTokens> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.clientId,
    refresh_token: refreshTokenValue,
  });

  const res = await fetch(config.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status}`);
  }

  const data = (await res.json()) as Record<string, unknown>;

  return {
    accessToken: data.access_token as string,
    refreshToken: (data.refresh_token as string) ?? refreshTokenValue,
    expiresAt: data.expires_in
      ? Date.now() + (data.expires_in as number) * 1000
      : undefined,
    tokenType: (data.token_type as string) ?? "Bearer",
  };
}
