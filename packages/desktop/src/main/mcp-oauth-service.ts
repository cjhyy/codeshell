import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens as SdkOAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  CredentialStore,
  authorize,
  createHardenedOAuthFetch,
  mergeOAuthTokenResponse,
  parseOAuthCredentialSecret,
  shouldRefreshOAuthCredential,
  type Credential,
  type MaskedCredential,
  type OAuthCredentialSecret,
  type OAuthTokenResponse,
  type OAuthTokens,
} from "@cjhyy/code-shell-core";
import { MCP_OAUTH_PROFILES, type McpOAuthProfile } from "./mcp-oauth-profiles.js";

export type McpOAuthLoginInput =
  | { source: "catalog"; profileId: string; credentialId?: string }
  | {
      source: "mcp";
      serverName: string;
      serverUrl: string;
      credentialId?: string;
      clientId?: string;
      authorizationEndpoint?: string;
      tokenEndpoint?: string;
      scopes?: string[];
    };

export interface McpOAuthActionResult {
  credential: MaskedCredential;
  warning?: "remote_revoke_failed";
}

type OAuthErrorCode = NonNullable<Credential["meta"]>["lastRefreshErrorCode"];

interface McpOAuthServiceOptions {
  store?: CredentialStore;
  fetch?: typeof fetch;
  openExternal: (url: string) => Promise<void> | void;
  authorizeFn?: typeof authorize;
  profiles?: Readonly<Record<string, McpOAuthProfile>>;
  now?: () => number;
  onCredentialsChanged?: () => void;
}

interface LoginSpec {
  credentialId: string;
  label: string;
  provider?: string;
  serverName?: string;
  serverUrl: string;
  clientId?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  revocationEndpoint?: string;
  scopes?: string[];
}

class NormalizedOAuthError extends Error {
  constructor(
    message: string,
    readonly code: OAuthErrorCode,
  ) {
    super(message);
  }
}

function safeCredentialId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new Error("OAuth credential id contains unsupported characters");
  }
  return id;
}

function generatedCredentialId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
  return safeCredentialId(`${slug || "mcp"}-oauth`);
}

export function validateOAuthEndpoint(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  const local =
    url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error(`${label} must use HTTPS (HTTP is allowed only for localhost)`);
  }
  if (url.username || url.password) throw new Error(`${label} must not include URL credentials`);
  return url;
}

function normalizedErrorCode(err: unknown): OAuthErrorCode {
  if (err instanceof NormalizedOAuthError) return err.code;
  const message = err instanceof Error ? err.message : String(err);
  if (/invalid_grant/i.test(message)) return "invalid_grant";
  if (/fetch|network|ECONN|ENOTFOUND|timed out/i.test(message)) return "network";
  if (/\(5\d\d\)|server/i.test(message)) return "server_error";
  return "invalid_response";
}

async function responseError(response: Response, action: string): Promise<NormalizedOAuthError> {
  let code: OAuthErrorCode = response.status >= 500 ? "server_error" : "invalid_response";
  try {
    const data = (await response.json()) as { error?: unknown };
    if (data.error === "invalid_grant") code = "invalid_grant";
  } catch {
    // Never surface the raw response body: it can contain tokens/provider details.
  }
  return new NormalizedOAuthError(`OAuth ${action} failed (${response.status})`, code);
}

async function startLoopbackCallback(expectedState: string): Promise<{
  redirectUrl: string;
  code: Promise<string>;
  close(): void;
}> {
  let settle!: (code: string) => void;
  let reject!: (err: Error) => void;
  const code = new Promise<string>((resolve, rejectPromise) => {
    settle = resolve;
    reject = rejectPromise;
  });
  let done = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end("Not found");
      return;
    }
    const finish = (err?: Error, authorizationCode?: string) => {
      if (done) return;
      done = true;
      if (err) reject(err);
      else settle(authorizationCode!);
    };
    if (url.searchParams.get("state") !== expectedState) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>Invalid OAuth callback</h1><p>You can close this window.</p>");
      finish(new Error("Invalid OAuth callback: state mismatch"));
      return;
    }
    const oauthError = url.searchParams.get("error");
    if (oauthError) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>Authorization was not completed</h1><p>You can close this window.</p>");
      finish(new Error(oauthError === "access_denied" ? "OAuth access denied" : "OAuth failed"));
      return;
    }
    const authorizationCode = url.searchParams.get("code");
    if (!authorizationCode) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>Invalid OAuth callback</h1><p>You can close this window.</p>");
      finish(new Error("Invalid OAuth callback: missing code"));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h1>Authorization successful</h1><p>You can close this window.</p>");
    finish(undefined, authorizationCode);
  });
  await new Promise<void>((resolve, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("OAuth callback listener failed to bind");
  }
  return {
    redirectUrl: `http://127.0.0.1:${address.port}/callback`,
    code,
    close: () => server.close(),
  };
}

export class McpOAuthService {
  private readonly store: CredentialStore;
  private readonly fetchFn: typeof fetch;
  private readonly authorizeFn: typeof authorize;
  private readonly profiles: Readonly<Record<string, McpOAuthProfile>>;
  private readonly now: () => number;
  private readonly refreshes = new Map<
    string,
    Promise<{ accessToken: string; expiresAt?: string }>
  >();

  constructor(private readonly options: McpOAuthServiceOptions) {
    this.store = options.store ?? new CredentialStore(undefined);
    this.fetchFn = createHardenedOAuthFetch(options.fetch ?? fetch);
    this.authorizeFn = options.authorizeFn ?? authorize;
    this.profiles = options.profiles ?? MCP_OAUTH_PROFILES;
    this.now = options.now ?? Date.now;
  }

  async login(input: McpOAuthLoginInput): Promise<McpOAuthActionResult> {
    const spec = this.loginSpec(input);
    validateOAuthEndpoint(spec.serverUrl, "MCP server URL");
    if (spec.authorizationEndpoint)
      validateOAuthEndpoint(spec.authorizationEndpoint, "authorization endpoint");
    if (spec.tokenEndpoint) validateOAuthEndpoint(spec.tokenEndpoint, "token endpoint");
    if (spec.revocationEndpoint)
      validateOAuthEndpoint(spec.revocationEndpoint, "revocation endpoint");
    const hasExplicitEndpoint = Boolean(spec.authorizationEndpoint || spec.tokenEndpoint);
    if (
      hasExplicitEndpoint &&
      !(spec.clientId && spec.authorizationEndpoint && spec.tokenEndpoint)
    ) {
      throw new Error(
        "Explicit OAuth metadata requires clientId, authorizationEndpoint and tokenEndpoint",
      );
    }

    const result =
      spec.clientId && spec.authorizationEndpoint && spec.tokenEndpoint
        ? await this.explicitLogin(spec)
        : await this.discoveryLogin(spec);
    const credential = this.saveLogin(spec, result.secret, result.meta);
    return { credential };
  }

  async refresh(credentialId: string): Promise<McpOAuthActionResult> {
    await this.resolveAccessToken(safeCredentialId(credentialId), { forceRefresh: true });
    return { credential: this.masked(credentialId) };
  }

  async resolveAccessToken(
    credentialId: string,
    opts: { forceRefresh?: boolean } = {},
  ): Promise<{ accessToken: string; expiresAt?: string }> {
    const id = safeCredentialId(credentialId);
    const cred = this.oauthCredential(id);
    const secret = parseOAuthCredentialSecret(cred.secret!);
    const decision = shouldRefreshOAuthCredential(secret, { now: this.now });
    if (!opts.forceRefresh && decision === "no") {
      return { accessToken: secret.accessToken, expiresAt: secret.expiresAt };
    }
    if (!secret.refreshToken || !secret.tokenEndpoint || !secret.clientId) {
      throw new NormalizedOAuthError(`OAuth credential "${id}" requires login`, "invalid_grant");
    }

    const inflight = this.refreshes.get(id);
    const pending =
      inflight ??
      this.performRefresh(id, Boolean(opts.forceRefresh)).finally(() => {
        this.refreshes.delete(id);
      });
    if (!inflight) this.refreshes.set(id, pending);
    try {
      return await pending;
    } catch (err) {
      const trulyExpired = secret.expiresAt ? Date.parse(secret.expiresAt) <= this.now() : false;
      if (!opts.forceRefresh && !trulyExpired) {
        return { accessToken: secret.accessToken, expiresAt: secret.expiresAt };
      }
      throw err;
    }
  }

  async logout(credentialId: string): Promise<{ removed: true; remoteRevoked: boolean }> {
    const id = safeCredentialId(credentialId);
    const cred = this.oauthCredential(id);
    const secret = parseOAuthCredentialSecret(cred.secret!);
    let remoteRevoked = !secret.revocationEndpoint;
    if (secret.revocationEndpoint) {
      try {
        validateOAuthEndpoint(secret.revocationEndpoint, "revocation endpoint");
        const token = secret.refreshToken ?? secret.accessToken;
        const params = new URLSearchParams({ token });
        params.set("token_type_hint", secret.refreshToken ? "refresh_token" : "access_token");
        if (secret.clientId) params.set("client_id", secret.clientId);
        if (secret.clientSecret) params.set("client_secret", secret.clientSecret);
        const response = await this.fetchFn(secret.revocationEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
        });
        remoteRevoked = response.ok;
      } catch {
        remoteRevoked = false;
      }
    }
    this.store.remove("user", id);
    this.changed();
    return { removed: true, remoteRevoked };
  }

  private loginSpec(input: McpOAuthLoginInput): LoginSpec {
    if (input.source === "catalog") {
      const profile = this.profiles[input.profileId];
      if (!profile) throw new Error(`OAuth profile "${input.profileId}" is not supported`);
      return {
        credentialId: safeCredentialId(input.credentialId ?? `${profile.provider}-oauth`),
        label: `${profile.label} OAuth`,
        provider: profile.provider,
        serverUrl: profile.serverUrl,
        clientId: profile.clientId,
        authorizationEndpoint: profile.authorizationEndpoint,
        tokenEndpoint: profile.tokenEndpoint,
        revocationEndpoint: profile.revocationEndpoint,
        scopes: profile.scopes,
      };
    }
    const serverName = input.serverName.trim();
    if (!serverName) throw new Error("MCP OAuth login requires a server name");
    return {
      credentialId: safeCredentialId(input.credentialId ?? generatedCredentialId(serverName)),
      label: `${serverName} OAuth`,
      serverName,
      serverUrl: input.serverUrl.trim(),
      clientId: input.clientId?.trim() || undefined,
      authorizationEndpoint: input.authorizationEndpoint?.trim() || undefined,
      tokenEndpoint: input.tokenEndpoint?.trim() || undefined,
      scopes: input.scopes?.map((scope) => scope.trim()).filter(Boolean),
    };
  }

  private async explicitLogin(spec: LoginSpec): Promise<{
    secret: OAuthCredentialSecret;
    meta: Partial<NonNullable<Credential["meta"]>>;
  }> {
    const tokens = await this.authorizeFn(
      {
        clientId: spec.clientId!,
        authorizationEndpoint: spec.authorizationEndpoint!,
        tokenEndpoint: spec.tokenEndpoint!,
        scopes: spec.scopes,
        resource: spec.serverUrl,
      },
      { openExternal: this.options.openExternal, fetch: this.fetchFn },
    );
    return {
      secret: this.secretFromTokens(tokens, {
        clientId: spec.clientId,
        tokenEndpoint: spec.tokenEndpoint,
        revocationEndpoint: spec.revocationEndpoint,
        resource: spec.serverUrl,
        scopes: spec.scopes,
      }),
      meta: {
        authUrl: spec.authorizationEndpoint,
        tokenEndpoint: spec.tokenEndpoint,
        revocationEndpoint: spec.revocationEndpoint,
        clientId: spec.clientId,
        scopes: spec.scopes,
        resource: spec.serverUrl,
      },
    };
  }

  private async discoveryLogin(spec: LoginSpec): Promise<{
    secret: OAuthCredentialSecret;
    meta: Partial<NonNullable<Credential["meta"]>>;
  }> {
    const state = randomBytes(16).toString("hex");
    const callback = await startLoopbackCallback(state);
    let tokens: SdkOAuthTokens | undefined;
    let verifier = "";
    let clientInformation: OAuthClientInformationMixed | undefined = spec.clientId
      ? { client_id: spec.clientId }
      : undefined;
    let discovery: OAuthDiscoveryState | undefined;
    const clientMetadata: OAuthClientMetadata = {
      client_name: "CodeShell",
      redirect_uris: [callback.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: spec.scopes?.join(" "),
    };
    const provider: OAuthClientProvider = {
      redirectUrl: callback.redirectUrl,
      clientMetadata,
      state: () => state,
      clientInformation: () => clientInformation,
      saveClientInformation: (info) => {
        clientInformation = info;
      },
      tokens: () => tokens,
      saveTokens: (next) => {
        tokens = next;
      },
      redirectToAuthorization: async (url) => {
        validateOAuthEndpoint(url.toString(), "authorization endpoint");
        await this.options.openExternal(url.toString());
      },
      saveCodeVerifier: (next) => {
        verifier = next;
      },
      codeVerifier: () => verifier,
      saveDiscoveryState: (next) => {
        discovery = next;
      },
      discoveryState: () => discovery,
    };
    const safeFetch = (async (url: string | URL, init?: RequestInit) => {
      validateOAuthEndpoint(url.toString(), "OAuth discovery endpoint");
      return this.fetchFn(url, init);
    }) as typeof fetch;
    let callbackTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const first = await auth(provider, {
        serverUrl: spec.serverUrl,
        fetchFn: safeFetch as never,
      });
      if (first !== "REDIRECT") throw new Error("OAuth discovery did not start authorization");
      const authorizationCode = await Promise.race([
        callback.code,
        new Promise<never>((_resolve, reject) => {
          callbackTimeout = setTimeout(
            () => reject(new Error("OAuth authorization timed out")),
            120_000,
          );
        }),
      ]);
      await auth(provider, {
        serverUrl: spec.serverUrl,
        authorizationCode,
        fetchFn: safeFetch as never,
      });
    } finally {
      if (callbackTimeout) clearTimeout(callbackTimeout);
      callback.close();
    }
    if (!tokens) throw new Error("OAuth token exchange returned no tokens");
    const metadata = discovery?.authorizationServerMetadata;
    const registered = clientInformation as Record<string, unknown> | undefined;
    const clientId =
      typeof registered?.client_id === "string" ? registered.client_id : spec.clientId;
    if (!clientId) throw new Error("OAuth client registration returned no client id");
    const clientSecret =
      typeof registered?.client_secret === "string" ? registered.client_secret : undefined;
    const response: OAuthTokenResponse = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
      token_type: tokens.token_type,
      scope: tokens.scope,
    };
    const secret = mergeOAuthTokenResponse(undefined, response, { now: this.now() });
    secret.clientId = clientId;
    secret.clientSecret = clientSecret;
    secret.clientRegistration = {
      clientId,
      clientSecret,
      clientIdIssuedAt:
        typeof registered?.client_id_issued_at === "number"
          ? registered.client_id_issued_at
          : undefined,
      clientSecretExpiresAt:
        typeof registered?.client_secret_expires_at === "number"
          ? registered.client_secret_expires_at
          : undefined,
    };
    secret.issuer = metadata?.issuer ?? discovery?.authorizationServerUrl;
    secret.resource = discovery?.resourceMetadata?.resource ?? spec.serverUrl;
    secret.tokenEndpoint = metadata?.token_endpoint;
    secret.revocationEndpoint = (
      metadata as (typeof metadata & { revocation_endpoint?: string }) | undefined
    )?.revocation_endpoint;
    secret.scopes = spec.scopes;
    if (!secret.tokenEndpoint) throw new Error("OAuth discovery returned no token endpoint");
    return {
      secret,
      meta: {
        issuer: secret.issuer,
        resource: secret.resource,
        authUrl: metadata?.authorization_endpoint,
        tokenEndpoint: secret.tokenEndpoint,
        revocationEndpoint: secret.revocationEndpoint,
        clientId,
        scopes: spec.scopes,
      },
    };
  }

  private secretFromTokens(
    tokens: OAuthTokens,
    retained: Partial<OAuthCredentialSecret>,
  ): OAuthCredentialSecret {
    return {
      version: 1,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : undefined,
      tokenType: tokens.tokenType,
      scope: tokens.scope,
      ...retained,
    };
  }

  private saveLogin(
    spec: LoginSpec,
    secret: OAuthCredentialSecret,
    discoveredMeta: Partial<NonNullable<Credential["meta"]>>,
  ): MaskedCredential {
    this.store.save("user", {
      id: spec.credentialId,
      type: "oauth",
      label: spec.label,
      secret: JSON.stringify(secret),
      meta: {
        ...discoveredMeta,
        oauthProvider: spec.provider,
        mcpServerName: spec.serverName,
        mcpServerUrl: spec.serverUrl,
      },
    });
    this.changed();
    return this.masked(spec.credentialId);
  }

  private async performRefresh(
    id: string,
    force: boolean,
  ): Promise<{ accessToken: string; expiresAt?: string }> {
    const cred = this.oauthCredential(id);
    const secret = parseOAuthCredentialSecret(cred.secret!);
    if (!force && shouldRefreshOAuthCredential(secret, { now: this.now }) === "no") {
      return { accessToken: secret.accessToken, expiresAt: secret.expiresAt };
    }
    if (!secret.refreshToken || !secret.tokenEndpoint || !secret.clientId) {
      throw new NormalizedOAuthError(`OAuth credential "${id}" requires login`, "invalid_grant");
    }
    try {
      validateOAuthEndpoint(secret.tokenEndpoint, "token endpoint");
      const params = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: secret.refreshToken,
        client_id: secret.clientId,
      });
      if (secret.clientSecret) params.set("client_secret", secret.clientSecret);
      if (secret.scope) params.set("scope", secret.scope);
      if (secret.resource) params.set("resource", secret.resource);
      const response = await this.fetchFn(secret.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      if (!response.ok) throw await responseError(response, "refresh");
      const next = mergeOAuthTokenResponse(secret, (await response.json()) as OAuthTokenResponse, {
        now: this.now(),
      });
      this.store.save("user", {
        ...cred,
        secret: JSON.stringify(next),
        meta: {
          ...cred.meta,
          lastRefreshAt: new Date(this.now()).toISOString(),
          lastRefreshFailedAt: undefined,
          lastRefreshErrorCode: undefined,
        },
      });
      this.changed();
      return { accessToken: next.accessToken, expiresAt: next.expiresAt };
    } catch (err) {
      const code = normalizedErrorCode(err);
      this.store.save("user", {
        ...cred,
        meta: {
          ...cred.meta,
          lastRefreshFailedAt: new Date(this.now()).toISOString(),
          lastRefreshErrorCode: code,
        },
      });
      this.changed();
      throw new NormalizedOAuthError(
        code === "invalid_grant"
          ? `OAuth credential "${id}" requires login`
          : "OAuth refresh failed",
        code,
      );
    }
  }

  private oauthCredential(id: string): Credential {
    const cred = this.store.resolve(id, "full");
    if (!cred || cred.type !== "oauth" || !cred.secret) {
      throw new Error(`OAuth credential "${id}" is unavailable`);
    }
    return cred;
  }

  private masked(id: string): MaskedCredential {
    const credential = this.store.listMasked("full").find((item) => item.id === id);
    if (!credential) throw new Error(`OAuth credential "${id}" is unavailable`);
    return credential;
  }

  private changed(): void {
    this.options.onCredentialsChanged?.();
  }
}
