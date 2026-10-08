import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { CredentialStore } from "../credentials/store.js";
import type { Credential } from "../credentials/types.js";
import { parseOAuthCredentialSecret } from "../credentials/oauth.js";
import { asRecord, asArray } from "./http.js";
import {
  getRemoteLinkProviderAdapter,
  LEGACY_GITHUB_ACTIONS,
  normalizeRemoteLinkActionResult,
  parseRemoteLinkResourceGroups,
  prepareRemoteLinkAction,
  reviewedRemoteLinkActions,
  type RemoteLinkProviderId,
} from "./remote-adapters.js";

const SCOPES = LEGACY_GITHUB_ACTIONS.map((id) => `github:${id}`);
const pendingRefreshes = new Map<string, Promise<void>>();
const consumedAttempts = new WeakSet<RemoteLinkAttempt>();
export class RemoteLinkError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "unavailable"
      | "reconnect"
      | "changed"
      | "forbidden"
      | "busy",
  ) {
    super(
      {
        invalid_request: "远程 Link 请求无效。",
        unavailable: "无法连接 Link 服务，请稍后重试。",
        reconnect: "Link 授权失效或刷新结果不明，请重新连接。",
        changed: "Link 连接已改变，请重新选择。",
        forbidden: "这个 Link 授权不允许该操作或资源。",
        busy: "Link 正在刷新授权；若重启后仍未完成，请重新连接。",
      }[code],
    );
    this.name = "RemoteLinkError";
  }
}
export interface RemoteLinkConfiguration {
  issuer: string;
  clientId: string;
  redirectUri: string;
  clientSecret?: string;
}
export interface RemoteLinkAttempt {
  configuration: RemoteLinkConfiguration;
  state: string;
  verifier: string;
  expiresAt: number;
  authorizationUrl: string;
  providerId?: RemoteLinkProviderId;
  actions?: string[];
}
function string(value: unknown, max = 4096): string {
  if (typeof value !== "string" || !value || value.length > max || /[\x00-\x20\x7f]/.test(value))
    throw new RemoteLinkError("invalid_request");
  return value;
}
function origin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RemoteLinkError("invalid_request");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
  )
    throw new RemoteLinkError("invalid_request");
  return url.origin;
}
export function beginRemoteLinkAuthorization(
  configuration: RemoteLinkConfiguration,
  now = Date.now(),
  capabilities: { providerId: string; actions?: readonly string[] } = {
    providerId: "github",
    actions: LEGACY_GITHUB_ACTIONS,
  },
): RemoteLinkAttempt {
  const adapter = getRemoteLinkProviderAdapter(capabilities.providerId);
  if (!adapter) throw new RemoteLinkError("invalid_request");
  let actions: string[];
  try {
    actions = reviewedRemoteLinkActions(adapter.id, capabilities.actions ?? adapter.actions);
  } catch {
    throw new RemoteLinkError("invalid_request");
  }
  const config = {
    ...configuration,
    issuer: origin(configuration.issuer),
    clientId: string(configuration.clientId, 512),
  };
  const redirect = new URL(config.redirectUri);
  if (
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash ||
    (redirect.protocol !== "https:" &&
      !(
        redirect.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname)
      ))
  )
    throw new RemoteLinkError("invalid_request");
  if (config.clientSecret) string(config.clientSecret);
  const state = randomBytes(32).toString("base64url"),
    verifier = randomBytes(48).toString("base64url");
  const url = new URL("/oauth/authorize", config.issuer);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    provider_id: adapter.id,
    scope: actions.map((action) => `${adapter.id}:${action}`).join(" "),
  }))
    url.searchParams.set(key, value);
  return {
    configuration: config,
    providerId: adapter.id,
    actions,
    state,
    verifier,
    expiresAt: now + 10 * 60_000,
    authorizationUrl: url.href,
  };
}
/** Node's request sends exactly once. Some fetch runtimes retry POST on a stale socket. */
async function requestOnce(url: URL, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const operation = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: init.method ?? "GET",
        headers: Object.fromEntries(new Headers(init.headers)),
        signal: init.signal ?? undefined,
        // Do not reuse a stale socket for an authorization-code or refresh-token exchange.
        agent: false,
      },
      (response) => {
        try {
          const status = response.statusCode ?? 503;
          const body = [204, 205, 304].includes(status)
            ? null
            : (Readable.toWeb(response) as ReadableStream<Uint8Array>);
          if (!body) response.resume();
          resolve(new Response(body, { status, headers: { "Content-Type": "application/json" } }));
        } catch (error) {
          response.destroy();
          reject(error);
        }
      },
    );
    operation.on("error", reject);
    operation.end(init.body === undefined ? undefined : String(init.body));
  });
}

async function request(
  issuer: string,
  path: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  try {
    const response = await requestOnce(new URL(path, origin(issuer)), {
      ...init,
      redirect: "error",
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new RemoteLinkError(
        response.status === 401 || response.status === 400
          ? "reconnect"
          : response.status === 403
            ? "forbidden"
            : "unavailable",
      );
    }
    if (!response.body) throw new RemoteLinkError("unavailable");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new RemoteLinkError("unavailable");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const result = asRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!result) throw new RemoteLinkError("unavailable");
    return result;
  } catch (error) {
    if (error instanceof RemoteLinkError) throw error;
    throw new RemoteLinkError("unavailable");
  }
}
function tokenBody(
  config: Pick<RemoteLinkConfiguration, "clientId" | "clientSecret">,
  values: Record<string, string>,
): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...values,
      client_id: config.clientId,
      ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
    }),
  };
}
function tokens(raw: Record<string, unknown>, now: number, allowed = SCOPES) {
  const scope = typeof raw.scope === "string" ? raw.scope.split(" ").filter(Boolean) : [];
  if (
    (raw.token_type !== "Bearer" && raw.token_type !== "bearer") ||
    typeof raw.expires_in !== "number" ||
    !Number.isFinite(raw.expires_in) ||
    raw.expires_in <= 0 ||
    raw.expires_in > 86400 ||
    !scope.length ||
    new Set(scope).size !== scope.length ||
    scope.some((item) => !allowed.includes(item))
  )
    throw new RemoteLinkError("reconnect");
  return {
    version: 1 as const,
    accessToken: string(raw.access_token),
    refreshToken: string(raw.refresh_token),
    expiresAt: new Date(now + raw.expires_in * 1000).toISOString(),
    tokenType: "Bearer",
    scope: scope.join(" "),
  };
}
/** Host-owned attempt must be consumed exactly once before calling this function. */
export async function completeRemoteLinkAuthorization(
  attempt: RemoteLinkAttempt,
  callbackUrl: string,
  id: string,
  label: string,
  options: { now?: number; onTokens?: (credential: Credential) => void | Promise<void> } = {},
): Promise<Credential> {
  const now = options.now ?? Date.now();
  if (attempt.expiresAt <= now) throw new RemoteLinkError("reconnect");
  let callback: URL, redirect: URL;
  try {
    callback = new URL(callbackUrl);
    redirect = new URL(attempt.configuration.redirectUri);
  } catch {
    throw new RemoteLinkError("invalid_request");
  }
  if (
    callback.origin !== redirect.origin ||
    callback.pathname !== redirect.pathname ||
    callback.hash ||
    callback.username ||
    callback.password ||
    callback.searchParams.getAll("state").length !== 1 ||
    callback.searchParams.get("state") !== attempt.state ||
    callback.searchParams.has("error") ||
    callback.searchParams.getAll("code").length !== 1
  )
    throw new RemoteLinkError("invalid_request");
  const code = string(callback.searchParams.get("code"));
  if (consumedAttempts.has(attempt)) throw new RemoteLinkError("reconnect");
  consumedAttempts.add(attempt);
  const config = attempt.configuration;
  const providerId = attempt.providerId ?? "github";
  let allowedScopes: string[];
  try {
    allowedScopes = reviewedRemoteLinkActions(
      providerId,
      attempt.actions ?? LEGACY_GITHUB_ACTIONS,
    ).map((action) => `${providerId}:${action}`);
  } catch {
    throw new RemoteLinkError("reconnect");
  }
  const secret = {
    ...tokens(
      await request(
        config.issuer,
        "/oauth/token",
        tokenBody(config, {
          grant_type: "authorization_code",
          code,
          redirect_uri: config.redirectUri,
          code_verifier: attempt.verifier,
        }),
      ),
      now,
      allowedScopes,
    ),
    issuer: config.issuer,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  };
  // Persist cleanup custody before the next request: metadata lookup may fail after minting.
  await options.onTokens?.({
    id,
    type: "oauth",
    label,
    secret: JSON.stringify(secret),
    autoUseByAI: false,
    meta: {
      linkExecutionRuntime: "server",
      linkExecutionBackend: "remote",
      linkRemoteIssuer: config.issuer,
      linkRemoteState: "reconnect",
      agentExposable: false,
    },
  });
  const authorization = await request(config.issuer, "/api/v1/data/authorization", {
    headers: { Authorization: `Bearer ${secret.accessToken}` },
  });
  const account = asRecord(authorization.account);
  const scopes = asArray(authorization.scopes);
  let resourceGroups;
  try {
    resourceGroups = parseRemoteLinkResourceGroups(providerId, authorization);
  } catch {
    throw new RemoteLinkError("reconnect");
  }
  const authorizedActions = scopes.map((scope) => String(scope).slice(providerId.length + 1));
  const declaredActions = authorization.actions;
  if (
    authorization.version !== 1 ||
    authorization.providerId !== providerId ||
    !account ||
    !["number", "string"].includes(typeof account.id) ||
    (typeof account.id === "number" && (!Number.isSafeInteger(account.id) || account.id <= 0)) ||
    /[\x00-\x1f\x7f]/.test(String(account.id)) ||
    !String(account.id) ||
    String(account.id).length > 300 ||
    typeof account.login !== "string" ||
    !account.login ||
    account.login.length > 200 ||
    /[\x00-\x1f\x7f]/.test(account.login) ||
    !scopes.length ||
    scopes.some((scope) => typeof scope !== "string" || !secret.scope.split(" ").includes(scope)) ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => !allowedScopes.includes(String(scope))) ||
    (declaredActions === undefined
      ? providerId !== "github"
      : !Array.isArray(declaredActions) ||
        declaredActions.length !== scopes.length ||
        new Set(declaredActions).size !== declaredActions.length ||
        declaredActions.some(
          (action) => typeof action !== "string" || !authorizedActions.includes(action),
        ))
  )
    throw new RemoteLinkError("reconnect");
  const connectionId = string(authorization.connectionId, 36),
    grantId = string(authorization.grantId, 36);
  if (![connectionId, grantId].every((value) => /^[a-f0-9-]{36}$/.test(value)))
    throw new RemoteLinkError("reconnect");
  return {
    id,
    type: "oauth",
    label,
    secret: JSON.stringify(secret),
    autoUseByAI: false,
    meta: {
      linkProvider: providerId,
      linkConnectionMethod: "remote-link",
      linkExecutionRuntime: "server",
      linkExecutionBackend: "remote",
      agentExposable: false,
      linkRemoteIssuer: config.issuer,
      linkRemoteConnectionId: connectionId,
      linkRemoteGrantId: grantId,
      linkRemoteState: "connected",
      linkAccountId: String(account.id),
      linkAccountLabel:
        typeof account.label === "string" &&
        account.label &&
        account.label.length <= 300 &&
        !/[\x00-\x1f\x7f]/.test(account.label)
          ? account.label
          : account.login,
      linkResourceLabels: resourceGroups[0]!.items.map((item) => item.id),
      linkResourceGroups: resourceGroups,
      linkCapabilityIds: scopes.map((scope) => String(scope).replace(":", ".")),
      linkLastVerifiedAt: new Date(now).toISOString(),
    },
  };
}
/** Revoke a downstream grant without exporting or refreshing its private token. */
export async function revokeRemoteLinkAuthorization(credential: Credential): Promise<void> {
  if (!isRemoteLinkCredential(credential)) throw new RemoteLinkError("invalid_request");
  let secret;
  try {
    secret = parseOAuthCredentialSecret(credential.secret ?? "");
  } catch {
    throw new RemoteLinkError("reconnect");
  }
  if (
    !secret.issuer ||
    origin(secret.issuer) !== credential.meta?.linkRemoteIssuer ||
    !secret.clientId
  )
    throw new RemoteLinkError("reconnect");
  await request(
    secret.issuer,
    "/oauth/revoke",
    tokenBody(
      { clientId: secret.clientId, clientSecret: secret.clientSecret },
      {
        token: secret.refreshToken || secret.accessToken,
        token_type_hint: secret.refreshToken ? "refresh_token" : "access_token",
      },
    ),
  );
}
export function isRemoteLinkCredential(value: Pick<Credential, "type" | "meta">): boolean {
  return (
    value.type === "oauth" &&
    value.meta?.linkExecutionRuntime === "server" &&
    value.meta.linkExecutionBackend === "remote"
  );
}
export interface RemoteLinkActionRequest {
  cwd?: string;
  id: string;
  scope: "full" | "project";
  action: string;
  params: Record<string, unknown>;
  /** Prevent dispatch after the selected account/grant was replaced. */
  grantId: string;
}
export async function executeRemoteLinkAction(
  input: RemoteLinkActionRequest,
  options: {
    store?: CredentialStore;
    signal?: AbortSignal;
    now?: () => number;
  } = {},
): Promise<unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    (input.cwd !== undefined && typeof input.cwd !== "string") ||
    typeof input.id !== "string" ||
    !input.id ||
    input.id.length > 512 ||
    !["full", "project"].includes(input.scope) ||
    typeof input.grantId !== "string" ||
    !asRecord(input.params) ||
    typeof input.action !== "string"
  )
    throw new RemoteLinkError("invalid_request");
  const store = options.store ?? new CredentialStore(input.cwd);
  const now = options.now ?? Date.now;
  const read = () => {
    const current = store.resolve(input.id, input.scope);
    if (
      !current ||
      !isRemoteLinkCredential(current) ||
      current.meta?.linkRemoteGrantId !== input.grantId
    )
      throw new RemoteLinkError("changed");
    if (!["connected", "refreshing"].includes(current.meta.linkRemoteState ?? ""))
      throw new RemoteLinkError("reconnect");
    return current;
  };
  let current = read();
  const providerId = current.meta!.linkProvider ?? "";
  const assertAction = (credential: Credential) => {
    const adapter = getRemoteLinkProviderAdapter(providerId);
    if (
      !adapter ||
      credential.meta?.linkProvider !== providerId ||
      !(adapter.actions as readonly string[]).includes(input.action) ||
      !credential.meta?.linkCapabilityIds?.includes(`${providerId}.${input.action}`)
    )
      throw new RemoteLinkError("forbidden");
  };
  const resources = (credential: Credential) => {
    try {
      return parseRemoteLinkResourceGroups(
        providerId,
        credential.meta?.linkResourceGroups
          ? { resourceGroups: credential.meta.linkResourceGroups }
          : { repositories: credential.meta?.linkResourceLabels },
      );
    } catch {
      throw new RemoteLinkError("reconnect");
    }
  };
  const prepare = (credential: Credential) => {
    assertAction(credential);
    try {
      return prepareRemoteLinkAction(providerId, input.action, input.params, resources(credential));
    } catch (error) {
      if (error instanceof RemoteLinkError) throw error;
      throw new RemoteLinkError("forbidden");
    }
  };
  prepare(current);
  const layer = store.list("project").some((item) => item.id === input.id) ? "project" : "user";
  const parse = (credential: Credential) => {
    let value;
    try {
      value = parseOAuthCredentialSecret(credential.secret ?? "");
    } catch {
      throw new RemoteLinkError("reconnect");
    }
    if (
      !value.refreshToken ||
      !value.clientId ||
      !value.issuer ||
      origin(value.issuer) !== credential.meta?.linkRemoteIssuer ||
      !value.expiresAt
    )
      throw new RemoteLinkError("reconnect");
    return value as typeof value & {
      refreshToken: string;
      clientId: string;
      issuer: string;
      expiresAt: string;
    };
  };
  let secret = parse(current);
  options.signal?.throwIfAborted();
  if (
    Date.parse(secret.expiresAt) <= now() + 30_000 ||
    current.meta?.linkRemoteState === "refreshing"
  ) {
    const key = createHash("sha256").update(secret.refreshToken).digest("hex");
    let pending = pendingRefreshes.get(key);
    if (!pending) {
      if (current.meta?.linkRemoteState === "refreshing") throw new RemoteLinkError("busy");
      const original = current,
        originalSecret = secret;
      pending = Promise.resolve()
        .then(async () => {
          const marked: Credential = {
            ...original,
            meta: { ...original.meta, linkRemoteState: "refreshing" },
          };
          if (!store.compareAndSwap(layer, input.id, original, marked))
            throw new RemoteLinkError("changed");
          try {
            const next = tokens(
              await request(
                originalSecret.issuer,
                "/oauth/token",
                tokenBody(originalSecret, {
                  grant_type: "refresh_token",
                  refresh_token: originalSecret.refreshToken,
                }),
              ),
              now(),
              original.meta?.linkCapabilityIds?.map((capability) => capability.replace(".", ":")) ??
                [],
            );
            const updated: Credential = {
              ...marked,
              secret: JSON.stringify({ ...originalSecret, ...next }),
              meta: {
                ...marked.meta,
                linkRemoteState: "connected",
                linkCapabilityIds: next.scope.split(" ").map((scope) => scope.replace(":", ".")),
              },
            };
            if (!store.compareAndSwap(layer, input.id, marked, updated))
              throw new RemoteLinkError("changed");
          } catch (error) {
            store.compareAndSwap(layer, input.id, marked, {
              ...marked,
              meta: { ...marked.meta, linkRemoteState: "reconnect" },
            });
            if (error instanceof RemoteLinkError && error.code === "changed") throw error;
            throw new RemoteLinkError("reconnect");
          }
        })
        .finally(() => pendingRefreshes.delete(key));
      pendingRefreshes.set(key, pending);
    }
    await pending;
    current = read();
    secret = parse(current);
    if (current.meta?.linkRemoteState !== "connected" || Date.parse(secret.expiresAt) <= now())
      throw new RemoteLinkError("reconnect");
  }
  const body = prepare(current);
  const authority = (credential: Credential) =>
    JSON.stringify({
      provider: credential.meta?.linkProvider,
      issuer: credential.meta?.linkRemoteIssuer,
      connection: credential.meta?.linkRemoteConnectionId,
      grant: credential.meta?.linkRemoteGrantId,
      account: credential.meta?.linkAccountId,
      resources: resources(credential),
      capabilities: credential.meta?.linkCapabilityIds,
      verifiedAt: credential.meta?.linkLastVerifiedAt,
    });
  const originalAuthority = authority(current);
  const connection = string(current.meta?.linkRemoteConnectionId, 36);
  if (!/^[a-f0-9-]{36}$/.test(connection)) throw new RemoteLinkError("reconnect");
  options.signal?.throwIfAborted();
  let response: Record<string, unknown>;
  try {
    response = await request(
      secret.issuer,
      `/api/v1/data/connections/${connection}/actions/${input.action}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: options.signal,
      },
    );
  } catch (error) {
    if (error instanceof RemoteLinkError && error.code === "reconnect") {
      store.compareAndSwap(layer, input.id, current, {
        ...current,
        meta: { ...current.meta, linkRemoteState: "reconnect" },
      });
    }
    throw error;
  }
  const latest = read();
  if (
    latest.meta?.linkRemoteState !== "connected" ||
    latest.meta.linkRemoteConnectionId !== connection ||
    latest.meta.linkRemoteIssuer !== secret.issuer ||
    !latest.meta.linkCapabilityIds?.includes(`${providerId}.${input.action}`) ||
    authority(latest) !== originalAuthority
  )
    throw new RemoteLinkError("changed");
  options.signal?.throwIfAborted();
  try {
    return normalizeRemoteLinkActionResult(
      providerId,
      input.action,
      response.result,
      input.params,
      resources(latest),
    );
  } catch {
    throw new RemoteLinkError("unavailable");
  }
}
