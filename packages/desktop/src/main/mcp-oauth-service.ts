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
  logger,
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

export type McpOAuthServiceErrorCode =
  | "invalid_request"
  | "access_denied"
  | "timeout"
  | "network_error"
  | "server_error"
  | "protocol_error";

type OAuthFailureStage =
  | "validation"
  | "authorization"
  | "discovery_registration"
  | "authorization_callback"
  | "token_exchange";

interface McpOAuthServiceOptions {
  store?: CredentialStore;
  fetch?: typeof fetch;
  openExternal: (url: string) => Promise<void> | void;
  authorizeFn?: typeof authorize;
  profiles?: Readonly<Record<string, McpOAuthProfile>>;
  now?: () => number;
  onCredentialsChanged?: () => void;
  revocationTimeoutMs?: number;
  logWarning?: (event: string, fields: Record<string, unknown>) => void;
}

interface LoginSpec {
  credentialId: string;
  label: string;
  provider?: string;
  serverName?: string;
  serverUrl: string;
  clientId?: string;
  clientSecret?: string;
  clientRegistration?: OAuthCredentialSecret["clientRegistration"];
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

class StaleOAuthOperationError extends Error {}

class OAuthStageError extends Error {
  constructor(
    readonly stage: OAuthFailureStage,
    readonly internalCause: unknown,
  ) {
    super("OAuth stage failed");
  }
}

export class McpOAuthServiceError extends Error {
  readonly name = "McpOAuthServiceError";

  constructor(
    readonly code: McpOAuthServiceErrorCode,
    message: string,
    readonly stage: OAuthFailureStage,
    readonly status?: number,
  ) {
    super(`MCP_OAUTH_${code.toUpperCase()}: ${message}`);
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

function internalErrorMessage(error: unknown): string {
  if (error instanceof OAuthStageError) return internalErrorMessage(error.internalCause);
  return error instanceof Error ? error.message : String(error);
}

function internalStatus(error: unknown): number | undefined {
  if (error instanceof OAuthStageError) return internalStatus(error.internalCause);
  if (error && typeof error === "object") {
    const direct = (error as { status?: unknown }).status;
    if (typeof direct === "number" && direct >= 400 && direct <= 599) return direct;
    const responseStatus = (error as { response?: { status?: unknown } }).response?.status;
    if (typeof responseStatus === "number" && responseStatus >= 400 && responseStatus <= 599) {
      return responseStatus;
    }
  }
  const match = internalErrorMessage(error).match(/(?:^|\D)([45]\d{2})(?:\D|$)/);
  return match ? Number(match[1]) : undefined;
}

function publicOAuthError(error: unknown, fallbackStage: OAuthFailureStage): McpOAuthServiceError {
  if (error instanceof McpOAuthServiceError) return error;
  const stage = error instanceof OAuthStageError ? error.stage : fallbackStage;
  const message = internalErrorMessage(error);
  const status = internalStatus(error);
  let code: McpOAuthServiceErrorCode;
  let publicMessage: string;
  if (/access_denied|access denied/i.test(message)) {
    code = "access_denied";
    publicMessage = "OAuth authorization was denied";
  } else if (/timed out|timeout|aborted/i.test(message)) {
    code = "timeout";
    publicMessage = "OAuth authorization timed out";
  } else if (/fetch|network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    code = "network_error";
    publicMessage = "OAuth network request failed";
  } else if (status !== undefined && status >= 500) {
    code = "server_error";
    publicMessage = "OAuth failed";
  } else if (stage === "validation") {
    code = "invalid_request";
    publicMessage = "OAuth configuration is invalid";
  } else {
    code = "protocol_error";
    publicMessage = "OAuth failed";
  }
  return new McpOAuthServiceError(code, publicMessage, stage, status);
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
  let closing = false;
  const closeServer = () => {
    if (closing || !server.listening) return;
    closing = true;
    server.close();
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end("Not found");
      return;
    }
    if (done) {
      res.writeHead(410, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>OAuth callback already consumed</h1><p>You can close this window.</p>");
      return;
    }
    const finish = (err?: Error, authorizationCode?: string) => {
      if (done) return;
      done = true;
      closeServer();
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
    close: closeServer,
  };
}

export class McpOAuthService {
  private readonly store: CredentialStore;
  private readonly fetchFn: typeof fetch;
  private readonly authorizeFn: typeof authorize;
  private readonly profiles: Readonly<Record<string, McpOAuthProfile>>;
  private readonly now: () => number;
  private readonly revocationTimeoutMs: number;
  private readonly logWarning: (event: string, fields: Record<string, unknown>) => void;
  private readonly refreshes = new Map<
    string,
    Promise<{ accessToken: string; expiresAt?: string }>
  >();
  private readonly logins = new Map<string, Promise<McpOAuthActionResult>>();
  private readonly generations = new Map<string, number>();
  private readonly loggingOut = new Set<string>();
  private readonly logouts = new Map<string, Promise<{ removed: true; remoteRevoked: boolean }>>();

  constructor(private readonly options: McpOAuthServiceOptions) {
    this.store = options.store ?? new CredentialStore(undefined);
    this.fetchFn = createHardenedOAuthFetch(options.fetch ?? fetch);
    this.authorizeFn = options.authorizeFn ?? authorize;
    this.profiles = options.profiles ?? MCP_OAUTH_PROFILES;
    this.now = options.now ?? Date.now;
    this.revocationTimeoutMs = Math.max(1, Math.min(30_000, options.revocationTimeoutMs ?? 5_000));
    this.logWarning = options.logWarning ?? ((event, fields) => logger.warn(event, fields));
  }

  async login(input: McpOAuthLoginInput): Promise<McpOAuthActionResult> {
    let stage: OAuthFailureStage = "validation";
    try {
      const requested = this.loginSpec(input);
      validateOAuthEndpoint(requested.serverUrl, "MCP server URL");
      this.assertLoginCredentialOwnership(requested);
      if (this.logins.has(requested.credentialId)) {
        throw new Error(`OAuth credential "${requested.credentialId}" login is already in progress`);
      }
      const spec = this.withStoredLoginMetadata(requested);
      if (this.loggingOut.has(spec.credentialId)) throw this.unavailable(spec.credentialId);
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

      const explicit = Boolean(spec.clientId && spec.authorizationEndpoint && spec.tokenEndpoint);
      stage = explicit ? "authorization" : "discovery_registration";
      // A login supersedes every operation based on the prior token set. The
      // generation check prevents a detached old refresh from saving, while
      // removing its singleflight entry lets post-login requests use the new
      // credential without joining that stale promise.
      const generation = this.generationOf(spec.credentialId) + 1;
      this.generations.set(spec.credentialId, generation);
      this.refreshes.delete(spec.credentialId);
      const operation = (async (): Promise<McpOAuthActionResult> => {
        const result = explicit ? await this.explicitLogin(spec) : await this.discoveryLogin(spec);
        const credential = this.saveLogin(spec, result.secret, result.meta, generation);
        return { credential };
      })();
      const pending = operation.finally(() => {
        if (this.logins.get(spec.credentialId) === pending) {
          this.logins.delete(spec.credentialId);
        }
      });
      this.logins.set(spec.credentialId, pending);
      return await pending;
    } catch (error) {
      const normalized = publicOAuthError(error, stage);
      this.logWarning("mcp.oauth.failed", {
        stage: normalized.stage,
        code: normalized.code,
        ...(normalized.status === undefined ? {} : { status: normalized.status }),
      });
      throw normalized;
    }
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
    if (this.loggingOut.has(id)) throw this.unavailable(id);
    const login = this.logins.get(id);
    if (login) {
      await login;
      return this.resolveAccessToken(id, opts);
    }
    const generation = this.generationOf(id);
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
    const operation = inflight ?? this.performRefresh(id, Boolean(opts.forceRefresh), generation);
    const pending = inflight
      ? operation
      : operation.finally(() => {
          if (this.refreshes.get(id) === pending) this.refreshes.delete(id);
        });
    if (!inflight) this.refreshes.set(id, pending);
    try {
      return await pending;
    } catch (err) {
      if (!this.isCurrentGeneration(id, generation)) throw this.unavailable(id);
      const trulyExpired = secret.expiresAt ? Date.parse(secret.expiresAt) <= this.now() : false;
      if (!opts.forceRefresh && !trulyExpired) {
        return { accessToken: secret.accessToken, expiresAt: secret.expiresAt };
      }
      throw err;
    }
  }

  logout(credentialId: string): Promise<{ removed: true; remoteRevoked: boolean }> {
    const id = safeCredentialId(credentialId);
    const inflightLogout = this.logouts.get(id);
    if (inflightLogout) return inflightLogout;
    const cred = this.oauthCredential(id);
    this.loggingOut.add(id);
    this.generations.set(id, this.generationOf(id) + 1);
    const pending = this.performLogout(id, cred).finally(() => {
      this.logouts.delete(id);
    });
    this.logouts.set(id, pending);
    return pending;
  }

  private async performLogout(
    id: string,
    originalCredential: Credential,
  ): Promise<{ removed: true; remoteRevoked: boolean }> {
    let remoteRevoked = true;
    try {
      const inflightRefresh = this.refreshes.get(id);
      if (inflightRefresh) await inflightRefresh.catch(() => undefined);
      const current = this.store.resolve(id, "full");
      const credential = current?.type === "oauth" && current.secret ? current : originalCredential;
      const secret = parseOAuthCredentialSecret(credential.secret!);
      remoteRevoked = !secret.revocationEndpoint;
      if (secret.revocationEndpoint) {
        try {
          validateOAuthEndpoint(secret.revocationEndpoint, "revocation endpoint");
          const token = secret.refreshToken ?? secret.accessToken;
          const params = new URLSearchParams({ token });
          params.set("token_type_hint", secret.refreshToken ? "refresh_token" : "access_token");
          if (secret.clientId) params.set("client_id", secret.clientId);
          if (secret.clientSecret) params.set("client_secret", secret.clientSecret);
          const response = await this.fetchRevocation(secret.revocationEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params.toString(),
          });
          remoteRevoked = response.ok;
        } catch {
          remoteRevoked = false;
        }
      }
      return { removed: true, remoteRevoked };
    } finally {
      this.store.remove("user", id);
      this.loggingOut.delete(id);
      this.changed();
    }
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
    const scopes = input.scopes?.map((scope) => scope.trim()).filter(Boolean);
    return {
      credentialId: safeCredentialId(input.credentialId ?? generatedCredentialId(serverName)),
      label: `${serverName} OAuth`,
      serverName,
      serverUrl: input.serverUrl.trim(),
      clientId: input.clientId?.trim() || undefined,
      authorizationEndpoint: input.authorizationEndpoint?.trim() || undefined,
      tokenEndpoint: input.tokenEndpoint?.trim() || undefined,
      scopes: scopes?.length ? scopes : undefined,
    };
  }

  private withStoredLoginMetadata(spec: LoginSpec): LoginSpec {
    const prior = this.store.resolve(spec.credentialId, "full");
    if (
      !prior ||
      prior.type !== "oauth" ||
      !prior.secret ||
      prior.meta?.mcpServerUrl !== spec.serverUrl
    ) {
      return spec;
    }
    try {
      const secret = parseOAuthCredentialSecret(prior.secret);
      const storedClientId = secret.clientRegistration?.clientId ?? secret.clientId;
      const clientId = spec.clientId ?? storedClientId ?? prior.meta.clientId;
      const sameRegistration = Boolean(clientId && storedClientId && clientId === storedClientId);
      return {
        ...spec,
        clientId,
        clientSecret: sameRegistration
          ? (secret.clientSecret ?? secret.clientRegistration?.clientSecret)
          : undefined,
        clientRegistration: sameRegistration ? secret.clientRegistration : undefined,
        authorizationEndpoint: spec.authorizationEndpoint ?? prior.meta.authUrl,
        tokenEndpoint: spec.tokenEndpoint ?? secret.tokenEndpoint ?? prior.meta.tokenEndpoint,
        revocationEndpoint:
          spec.revocationEndpoint ?? secret.revocationEndpoint ?? prior.meta.revocationEndpoint,
        scopes: spec.scopes?.length
          ? spec.scopes
          : (secret.scopes ?? prior.meta.scopes ?? undefined),
      };
    } catch {
      return spec;
    }
  }

  private assertLoginCredentialOwnership(spec: LoginSpec): void {
    const prior = this.store.resolve(spec.credentialId, "full");
    if (!prior) return;
    const priorProvider = prior.meta?.oauthProvider;
    const sameProvider = priorProvider === spec.provider;
    let sameServer = false;
    try {
      const priorServer = prior.meta?.mcpServerUrl;
      sameServer =
        typeof priorServer === "string" &&
        new URL(priorServer).href === new URL(spec.serverUrl).href;
    } catch {
      sameServer = false;
    }
    if (prior.type !== "oauth" || !sameProvider || !sameServer) {
      throw new Error(
        `OAuth credential "${spec.credentialId}" belongs to another provider or MCP server`,
      );
    }
  }

  private async explicitLogin(spec: LoginSpec): Promise<{
    secret: OAuthCredentialSecret;
    meta: Partial<NonNullable<Credential["meta"]>>;
  }> {
    let tokens: OAuthTokens;
    try {
      tokens = await this.authorizeFn(
        {
          clientId: spec.clientId!,
          clientSecret: spec.clientSecret,
          authorizationEndpoint: spec.authorizationEndpoint!,
          tokenEndpoint: spec.tokenEndpoint!,
          scopes: spec.scopes,
          resource: spec.serverUrl,
        },
        { openExternal: this.options.openExternal, fetch: this.fetchFn },
      );
    } catch (error) {
      throw new OAuthStageError("authorization", error);
    }
    return {
      secret: this.secretFromTokens(tokens, {
        clientId: spec.clientId,
        clientSecret: spec.clientSecret,
        clientRegistration: spec.clientRegistration,
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
    let stage: OAuthFailureStage = "discovery_registration";
    try {
      const first = await auth(provider, {
        serverUrl: spec.serverUrl,
        fetchFn: safeFetch as never,
      });
      if (first !== "REDIRECT") throw new Error("OAuth discovery did not start authorization");
      stage = "authorization_callback";
      const authorizationCode = await Promise.race([
        callback.code,
        new Promise<never>((_resolve, reject) => {
          callbackTimeout = setTimeout(
            () => reject(new Error("OAuth authorization timed out")),
            120_000,
          );
        }),
      ]);
      stage = "token_exchange";
      await auth(provider, {
        serverUrl: spec.serverUrl,
        authorizationCode,
        fetchFn: safeFetch as never,
      });
    } catch (error) {
      throw new OAuthStageError(stage, error);
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
    generation: number,
  ): MaskedCredential {
    if (!this.isCurrentGeneration(spec.credentialId, generation)) {
      throw new StaleOAuthOperationError();
    }
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
    generation: number,
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
      const latest = this.credentialForGeneration(id, generation);
      this.store.save("user", {
        ...latest,
        secret: JSON.stringify(next),
        meta: {
          ...latest.meta,
          lastRefreshAt: new Date(this.now()).toISOString(),
          lastRefreshFailedAt: undefined,
          lastRefreshErrorCode: undefined,
        },
      });
      this.changed();
      return { accessToken: next.accessToken, expiresAt: next.expiresAt };
    } catch (err) {
      if (err instanceof StaleOAuthOperationError || !this.isCurrentGeneration(id, generation)) {
        throw this.unavailable(id);
      }
      const code = normalizedErrorCode(err);
      const latest = this.credentialForGeneration(id, generation);
      this.store.save("user", {
        ...latest,
        meta: {
          ...latest.meta,
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

  private generationOf(id: string): number {
    return this.generations.get(id) ?? 0;
  }

  private async fetchRevocation(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.fetchFn(url, { ...init, signal: controller.signal }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("OAuth revocation timed out"));
          }, this.revocationTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }

  private isCurrentGeneration(id: string, generation: number): boolean {
    return !this.loggingOut.has(id) && this.generationOf(id) === generation;
  }

  private credentialForGeneration(id: string, generation: number): Credential {
    if (!this.isCurrentGeneration(id, generation)) throw new StaleOAuthOperationError();
    const credential = this.store.resolve(id, "full");
    if (!credential || credential.type !== "oauth" || !credential.secret) {
      throw new StaleOAuthOperationError();
    }
    return credential;
  }

  private unavailable(id: string): Error {
    return new Error(`OAuth credential "${id}" is unavailable`);
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
