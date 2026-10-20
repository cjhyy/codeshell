import { linkConnectionMetadata } from "@cjhyy/code-shell-link";
import { createHash, randomBytes } from "node:crypto";
import { CredentialStore } from "../credentials/store.js";
import type { Credential } from "../credentials/types.js";
import { isCredentialSecretAvailable } from "../credentials/types.js";
import { parseOAuthCredentialSecret } from "../credentials/oauth.js";
import { logger } from "../logging/logger.js";
import { asRecord, asArray, LinkProviderResponseTooLargeError } from "./http.js";
import { requestOnce } from "./request-once.js";
import {
  FIGMA_RESPONSE_BYTES,
  FIGMA_RESPONSE_TOO_LARGE,
  FigmaContentUnavailableError,
  UnsupportedFigmaFileTypeError,
} from "./figma.js";
import {
  getRemoteLinkProviderAdapter,
  LEGACY_GITHUB_ACTIONS,
  normalizeRemoteLinkActionResult,
  normalizeRemoteFigmaFileInput,
  parseRemoteLinkResourceGroups,
  prepareRemoteLinkAction,
  reviewedRemoteLinkActions,
  RemoteLinkResourceNotGrantedError,
  type RemoteLinkProviderId,
} from "./remote-adapters.js";

const SCOPES = LEGACY_GITHUB_ACTIONS.map((id) => `github:${id}`);
const pendingRefreshes = new Map<string, Promise<void>>();
const consumedAttempts = new WeakSet<RemoteLinkAttempt>();
const BROKER_ERROR_CODES = [
  "invalid_request",
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "invalid_scope",
  "unsupported_grant_type",
  "access_denied",
  "invalid_token",
  "insufficient_scope",
  "grant_revoked",
  "connection_revoked",
  "connection_changed",
  "upstream_reauthorization_required",
  "credential_state_unavailable",
  "action_not_allowed",
  "resource_not_allowed",
  "invalid_parameters",
  "invalid_connection",
  "provider_not_configured",
  "upstream_token_missing",
  "upstream_account_missing",
  "upstream_unavailable",
  "upstream_response_too_large",
  "figma_response_too_large",
  "server_error",
  "internal_error",
  "temporarily_unavailable",
] as const;
type BrokerErrorCode = (typeof BROKER_ERROR_CODES)[number];
type DiagnosticReason =
  | "secret_unavailable"
  | "invalid_secret"
  | "binding_mismatch"
  | "scope_mismatch"
  | "resource_mismatch"
  | "invalid_connection"
  | "expired_after_refresh"
  | "orphaned_refresh"
  | "cas_mismatch"
  | "state_write_failed";
export interface RemoteLinkExecutionDiagnostic {
  stage: "preflight" | "token_refresh" | "action" | "state_write";
  outcome: "started" | "succeeded" | "failed" | "skipped";
  code?: RemoteLinkError["code"];
  reason?: DiagnosticReason;
  httpStatus?: number;
  brokerErrorCode?: BrokerErrorCode;
  state?: "refreshing" | "connected" | "reconnect";
}
export class RemoteLinkError extends Error {
  readonly httpStatus?: number;
  readonly brokerErrorCode?: BrokerErrorCode;
  readonly reason?: DiagnosticReason;
  constructor(
    readonly code:
      | "invalid_request"
      | "unavailable"
      | "configuration_error"
      | "refresh_outcome_unknown"
      | "reconnect"
      | "changed"
      | "forbidden"
      | "file_not_authorized"
      | "unsupported_file_type"
      | "response_too_large"
      | "content_unavailable"
      | "busy",
    diagnostic: Pick<
      RemoteLinkExecutionDiagnostic,
      "httpStatus" | "brokerErrorCode" | "reason"
    > = {},
  ) {
    super(
      {
        invalid_request: "远程 Link 请求无效。",
        unavailable: "无法连接 Link 服务，请稍后重试。",
        configuration_error: "Link 服务配置或刷新请求有误，请修正配置后重试；无需重新授权。",
        refresh_outcome_unknown: "Link 刷新可能已消费令牌，无法安全重试，请重新连接。",
        reconnect: "Link 授权失效或刷新结果不明，请重新连接。",
        changed: "Link 连接已改变，请重新选择。",
        forbidden: "这个 Link 授权不允许该操作或资源。",
        file_not_authorized:
          "请先在 Figma 连接卡片中点击“添加文件”，粘贴文件链接并确认授权后再读取。",
        unsupported_file_type: new UnsupportedFigmaFileTypeError().message,
        response_too_large: FIGMA_RESPONSE_TOO_LARGE,
        content_unavailable: new FigmaContentUnavailableError().message,
        busy: "Link 正在刷新授权；若重启后仍未完成，请重新连接。",
      }[code],
    );
    this.name = "RemoteLinkError";
    this.httpStatus = diagnostic.httpStatus;
    this.brokerErrorCode = diagnostic.brokerErrorCode;
    this.reason = diagnostic.reason;
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
  /** Exact file selection requested by the Host; [] connects the Figma account only. */
  resourceFiles?: string[];
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
  capabilities: {
    providerId: string;
    actions?: readonly string[];
    resourceFiles?: readonly string[];
  } = {
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
  let resourceFiles: string[] | undefined;
  if (capabilities.resourceFiles !== undefined) {
    if (
      adapter.id !== "figma" ||
      !Array.isArray(capabilities.resourceFiles) ||
      capabilities.resourceFiles.length > 101
    )
      throw new RemoteLinkError("invalid_request");
    try {
      resourceFiles = [...new Set(capabilities.resourceFiles.map(normalizeRemoteFigmaFileInput))];
      if (resourceFiles.length > 100 || JSON.stringify(resourceFiles).length > 20_000)
        throw new Error("Too many Figma files");
    } catch (error) {
      if (error instanceof UnsupportedFigmaFileTypeError)
        throw new RemoteLinkError("unsupported_file_type");
      throw new RemoteLinkError("invalid_request");
    }
    url.searchParams.set("resource_mode", resourceFiles.length ? "select" : "deferred");
    if (resourceFiles.length) url.searchParams.set("resource_files", JSON.stringify(resourceFiles));
  }
  if (url.href.length > 32_768) throw new RemoteLinkError("invalid_request");
  return {
    configuration: config,
    providerId: adapter.id,
    actions,
    ...(resourceFiles !== undefined ? { resourceFiles } : {}),
    state,
    verifier,
    expiresAt: now + 10 * 60_000,
    authorizationUrl: url.href,
  };
}

/** Read only a bounded, reviewed broker error enum; never retain provider messages. */
async function brokerError(
  response: Response,
  transport: AbortController,
): Promise<BrokerErrorCode | undefined> {
  if (!response.body || !response.headers.get("content-type")?.includes("application/json")) return;
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reading = (async () => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) return;
      chunks.push(value);
    }
    const code = asRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")))?.error;
    return typeof code === "string" && (BROKER_ERROR_CODES as readonly string[]).includes(code)
      ? (code as BrokerErrorCode)
      : undefined;
  })().catch(() => undefined);
  try {
    return await Promise.race([
      reading,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    transport.abort();
    void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      /* Preserve the known HTTP error. */
    }
  }
}
async function request(
  issuer: string,
  path: string,
  init: RequestInit,
  maxResponseBytes = 2 * 1024 * 1024,
  execution?: {
    stage: "token_refresh" | "action";
    report: (diagnostic: RemoteLinkExecutionDiagnostic) => void;
  },
): Promise<Record<string, unknown>> {
  const transport = new AbortController();
  let httpStatus: number | undefined;
  let brokerErrorCode: BrokerErrorCode | undefined;
  execution?.report({ stage: execution.stage, outcome: "started" });
  try {
    const response = await requestOnce(new URL(path, origin(issuer)), {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([
        ...(init.signal ? [init.signal] : []),
        transport.signal,
        AbortSignal.timeout(20_000),
      ]),
    });
    httpStatus = response.status;
    if (!response.ok) {
      brokerErrorCode = await brokerError(response, transport);
      transport.abort();
      void response.body?.cancel().catch(() => {});
      if (maxResponseBytes === FIGMA_RESPONSE_BYTES && response.status === 413)
        throw new RemoteLinkError("response_too_large", { httpStatus, brokerErrorCode });
      if (execution?.stage === "token_refresh") {
        // These broker OAuth rejections precede getRefreshToken/revokeToken.
        // Do not broaden this to other 4xx: invalid_scope, for example, can be
        // emitted after the rotating refresh token has already been consumed.
        const rejectedBeforeConsumption =
          (response.status === 400 || response.status === 401) &&
          [
            "invalid_request",
            "invalid_client",
            "unauthorized_client",
            "unsupported_grant_type",
          ].includes(brokerErrorCode ?? "");
        const revoked =
          (response.status === 400 || response.status === 401) &&
          ["invalid_grant", "grant_revoked", "connection_revoked"].includes(brokerErrorCode ?? "");
        throw new RemoteLinkError(
          rejectedBeforeConsumption
            ? "configuration_error"
            : revoked
              ? "reconnect"
              : "refresh_outcome_unknown",
          { httpStatus, brokerErrorCode },
        );
      }
      throw new RemoteLinkError(
        response.status === 400 && execution?.stage === "action"
          ? "invalid_request"
          : response.status === 401 || response.status === 400
            ? "reconnect"
            : response.status === 403
              ? "forbidden"
              : "unavailable",
        { httpStatus, brokerErrorCode },
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
        if (size > maxResponseBytes) {
          // Stop the physical request immediately. The Node/Web stream bridge's
          // cancellation can settle late or reject; neither should replace the
          // already known size error or hold a retry until the transport timeout.
          transport.abort();
          void reader.cancel().catch(() => {});
          throw new RemoteLinkError(
            maxResponseBytes === FIGMA_RESPONSE_BYTES ? "response_too_large" : "unavailable",
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const result = asRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!result) throw new RemoteLinkError("unavailable");
    execution?.report({ stage: execution.stage, outcome: "succeeded", httpStatus });
    return result;
  } catch (error) {
    const failure =
      error instanceof RemoteLinkError
        ? error
        : new RemoteLinkError("unavailable", { httpStatus, brokerErrorCode });
    execution?.report({
      stage: execution.stage,
      outcome: "failed",
      code: failure.code,
      httpStatus,
      brokerErrorCode,
    });
    throw failure;
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
    if (attempt.resourceFiles !== undefined) {
      const selected = resourceGroups[0]!.items.map((item) => item.id);
      if (
        selected.length !== attempt.resourceFiles.length ||
        attempt.resourceFiles.some((id) => !selected.includes(id))
      )
        throw new Error("Unexpected Figma file authorization");
    }
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
      recordSchemaVersion: 2,
      linkRecipeId: "broker-oauth",
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
    linkConnectionMetadata(value.meta).linkExecutionRuntime === "server" &&
    linkConnectionMetadata(value.meta).linkExecutionBackend === "remote"
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
    assertAuthorized?: () => void;
    now?: () => number;
    /** Receives reviewed enums/status only; diagnostics never change execution. */
    onDiagnostic?: (diagnostic: RemoteLinkExecutionDiagnostic) => void;
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
  const assertAuthorized = () => {
    options.signal?.throwIfAborted();
    options.assertAuthorized?.();
  };
  assertAuthorized();
  const store = options.store ?? new CredentialStore(input.cwd);
  const now = options.now ?? Date.now;
  const report = (diagnostic: RemoteLinkExecutionDiagnostic) => {
    try {
      if (options.onDiagnostic) options.onDiagnostic({ ...diagnostic });
      else if (diagnostic.outcome === "failed")
        logger.warn("link.remote.execution", { ...diagnostic });
      else logger.info("link.remote.execution", { ...diagnostic });
    } catch {
      /* Observability cannot alter authority or the operation result. */
    }
  };
  report({ stage: "preflight", outcome: "started" });
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
  let current: Credential;
  try {
    current = read();
  } catch (error) {
    report({
      stage: "preflight",
      outcome: "failed",
      code: error instanceof RemoteLinkError ? error.code : "unavailable",
    });
    throw error;
  }
  const providerId = current.meta!.linkProvider ?? "";
  const layer = store.list("project").some((item) => item.id === input.id) ? "project" : "user";
  const writeState = (
    expected: Credential,
    state: "refreshing" | "connected" | "reconnect",
    next?: Credential,
  ) => {
    // An undecryptable enc:* is custody, not a plaintext value that may be saved.
    if (!isCredentialSecretAvailable(expected.secret)) {
      report({
        stage: "state_write",
        outcome: "skipped",
        state,
        code: "reconnect",
        reason: "secret_unavailable",
      });
      return;
    }
    let matched: boolean;
    try {
      matched = store.compareAndSwap(
        layer,
        input.id,
        expected,
        next ?? {
          ...expected,
          meta: { ...expected.meta, linkRemoteState: state },
        },
      );
    } catch {
      report({
        stage: "state_write",
        outcome: "failed",
        state,
        code: "unavailable",
        reason: "state_write_failed",
      });
      throw new RemoteLinkError("unavailable", { reason: "state_write_failed" });
    }
    if (!matched) {
      report({
        stage: "state_write",
        outcome: "failed",
        state,
        code: "changed",
        reason: "cas_mismatch",
      });
      throw new RemoteLinkError("changed", { reason: "cas_mismatch" });
    }
    report({ stage: "state_write", outcome: "succeeded", state });
  };
  const preflight = <T>(credential: Credential, operation: () => T): T => {
    try {
      return operation();
    } catch (error) {
      const failure = error instanceof RemoteLinkError ? error : new RemoteLinkError("unavailable");
      report({ stage: "preflight", outcome: "failed", code: failure.code, reason: failure.reason });
      if (failure.code === "reconnect") writeState(credential, "reconnect");
      throw failure;
    }
  };
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
      throw new RemoteLinkError("reconnect", { reason: "resource_mismatch" });
    }
  };
  const prepare = (credential: Credential) => {
    assertAction(credential);
    try {
      return prepareRemoteLinkAction(providerId, input.action, input.params, resources(credential));
    } catch (error) {
      if (error instanceof RemoteLinkError) throw error;
      if (error instanceof UnsupportedFigmaFileTypeError)
        throw new RemoteLinkError("unsupported_file_type");
      if (error instanceof RemoteLinkResourceNotGrantedError)
        throw new RemoteLinkError("file_not_authorized");
      throw new RemoteLinkError("forbidden");
    }
  };
  const parse = (credential: Credential) => {
    if (!isCredentialSecretAvailable(credential.secret))
      throw new RemoteLinkError("reconnect", { reason: "secret_unavailable" });
    let value;
    try {
      value = parseOAuthCredentialSecret(credential.secret ?? "");
    } catch {
      throw new RemoteLinkError("reconnect", { reason: "invalid_secret" });
    }
    let issuer: string | undefined;
    try {
      issuer = value.issuer ? origin(value.issuer) : undefined;
    } catch {
      throw new RemoteLinkError("reconnect", { reason: "binding_mismatch" });
    }
    if (
      !value.refreshToken ||
      !value.clientId ||
      !value.issuer ||
      issuer !== credential.meta?.linkRemoteIssuer ||
      !value.expiresAt
    )
      throw new RemoteLinkError("reconnect", { reason: "binding_mismatch" });
    const scopes = typeof value.scope === "string" ? value.scope.split(/\s+/) : [];
    const capabilities = credential.meta?.linkCapabilityIds ?? [];
    const adapter = getRemoteLinkProviderAdapter(providerId)!;
    if (
      !scopes.length ||
      new Set(scopes).size !== scopes.length ||
      scopes.some(
        (scope) =>
          !(adapter.actions as readonly string[]).some(
            (action) => scope === `${providerId}:${action}`,
          ),
      ) ||
      !capabilities.length ||
      new Set(capabilities).size !== capabilities.length ||
      capabilities.some((capability) => !scopes.includes(capability.replace(".", ":")))
    )
      throw new RemoteLinkError("reconnect", { reason: "scope_mismatch" });
    if (!scopes.includes(`${providerId}:${input.action}`)) throw new RemoteLinkError("forbidden");
    return value as typeof value & {
      refreshToken: string;
      clientId: string;
      issuer: string;
      expiresAt: string;
    };
  };
  let secret = preflight(current, () => {
    prepare(current);
    return parse(current);
  });
  assertAuthorized();
  if (
    Date.parse(secret.expiresAt) <= now() + 30_000 ||
    current.meta?.linkRemoteState === "refreshing"
  ) {
    const key = createHash("sha256").update(secret.refreshToken).digest("hex");
    let pending = pendingRefreshes.get(key);
    if (!pending) {
      if (current.meta?.linkRemoteState === "refreshing") {
        report({
          stage: "token_refresh",
          outcome: "failed",
          code: "busy",
          reason: "orphaned_refresh",
        });
        throw new RemoteLinkError("busy", { reason: "orphaned_refresh" });
      }
      const original = current,
        originalSecret = secret;
      pending = Promise.resolve()
        .then(async () => {
          const marked: Credential = {
            ...original,
            meta: { ...original.meta, linkRemoteState: "refreshing" },
          };
          writeState(original, "refreshing", marked);
          try {
            const next = tokens(
              await request(
                originalSecret.issuer,
                "/oauth/token",
                tokenBody(originalSecret, {
                  grant_type: "refresh_token",
                  refresh_token: originalSecret.refreshToken,
                }),
                undefined,
                { stage: "token_refresh", report },
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
            writeState(marked, "connected", updated);
          } catch (error) {
            if (error instanceof RemoteLinkError && error.code === "changed") throw error;
            // A definite rejection before consumption leaves the same refresh
            // token usable after the configuration is corrected. Every other
            // unsuccessful rotation stays durably non-replayable, including a
            // successful response whose replacement could not be validated.
            const code =
              error instanceof RemoteLinkError && error.code === "configuration_error"
                ? "configuration_error"
                : error instanceof RemoteLinkError &&
                    error.code === "reconnect" &&
                    (error.httpStatus === 400 || error.httpStatus === 401) &&
                    ["invalid_grant", "grant_revoked", "connection_revoked"].includes(
                      error.brokerErrorCode ?? "",
                    )
                  ? "reconnect"
                  : "refresh_outcome_unknown";
            if (code === "configuration_error") writeState(marked, "connected", original);
            else writeState(marked, "reconnect");
            const diagnostic =
              error instanceof RemoteLinkError
                ? {
                    httpStatus: error.httpStatus,
                    brokerErrorCode: error.brokerErrorCode,
                    reason: error.reason,
                  }
                : {};
            report({ stage: "token_refresh", outcome: "failed", code, ...diagnostic });
            throw new RemoteLinkError(code, diagnostic);
          }
        })
        .finally(() => pendingRefreshes.delete(key));
      pendingRefreshes.set(key, pending);
    }
    await pending;
    assertAuthorized();
    current = read();
    secret = preflight(current, () => {
      const value = parse(current);
      if (current.meta?.linkRemoteState !== "connected" || Date.parse(value.expiresAt) <= now())
        throw new RemoteLinkError("reconnect", { reason: "expired_after_refresh" });
      return value;
    });
  }
  const body = preflight(current, () => prepare(current));
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
  const connection = preflight(current, () => {
    const value = current.meta?.linkRemoteConnectionId;
    if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value))
      throw new RemoteLinkError("reconnect", { reason: "invalid_connection" });
    return value;
  });
  report({ stage: "preflight", outcome: "succeeded" });
  assertAuthorized();
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
      providerId === "figma" ? FIGMA_RESPONSE_BYTES : undefined,
      { stage: "action", report },
    );
  } catch (error) {
    if (error instanceof RemoteLinkError && error.code === "reconnect") {
      writeState(current, "reconnect");
    }
    throw error;
  }
  assertAuthorized();
  const latest = read();
  if (
    latest.meta?.linkRemoteState !== "connected" ||
    latest.meta.linkRemoteConnectionId !== connection ||
    latest.meta.linkRemoteIssuer !== secret.issuer ||
    !latest.meta.linkCapabilityIds?.includes(`${providerId}.${input.action}`) ||
    authority(latest) !== originalAuthority
  )
    throw new RemoteLinkError("changed");
  assertAuthorized();
  try {
    return normalizeRemoteLinkActionResult(
      providerId,
      input.action,
      response.result,
      input.params,
      resources(latest),
    );
  } catch (error) {
    if (error instanceof FigmaContentUnavailableError)
      throw new RemoteLinkError("content_unavailable");
    if (error instanceof LinkProviderResponseTooLargeError)
      throw new RemoteLinkError("response_too_large");
    throw new RemoteLinkError("unavailable");
  }
}
