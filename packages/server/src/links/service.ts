import { linkConnectionMetadata } from "@cjhyy/code-shell-link";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  CredentialStore,
  beginRemoteLinkAuthorization,
  completeRemoteLinkAuthorization,
  revokeRemoteLinkAuthorization,
  isRemoteLinkCredential,
  type RemoteLinkConfiguration,
  type RemoteLinkAttempt,
  connectCliLink,
  getCliLinkStatus,
  isCliLinkProvider,
  isCredentialSecretAvailable,
  summarizeOAuthCredentialSecret,
  validateLocalLinkToken,
  type Credential,
  type LocalLinkValidationResult,
} from "@cjhyy/code-shell-core";
import { listDesktopLinkProviders } from "./catalog.js";
import {
  authorizationDiagnosticFailure,
  authorizationDiagnosticIdentity,
  authorizationDiagnosticStage,
  withLinkAuthorizationTrace,
  type LinkAuthorizationDiagnosticCode,
  type LinkAuthorizationDiagnosticSink,
} from "./diagnostics.js";
import {
  readRemoteProviderCatalog,
  readRemoteProviderCapabilities,
  RemoteLinkCatalogError,
  REMOTE_LINK_ADAPTERS,
  type RemoteProviderCapabilities,
} from "./remote-catalog.js";
import {
  LinkDeviceOAuthBroker,
  isLocalBrowserLinkProvider,
  type LocalBrowserAuthPrompt,
  type LocalBrowserAuthToken,
} from "./device-oauth.js";
import type {
  LinkAuthorization,
  LinkAuthorizationFailure,
  LinkAuthMode,
  LinkAuthorizationResponse,
  LinkAuthorizationStep,
  LinkConnectionInput,
  LinkErrorCode,
  LinkOperationContext,
  LinkSnapshot,
  MaskedLinkConnection,
  TokenConnectionInput,
  HostLinkOAuthAdapter,
} from "./types.js";

const messages: Record<LinkErrorCode, string> = {
  invalid_request: "Link 请求参数无效。",
  login_required: "登录已失效，请重新登录。",
  not_found: "找不到这个 Link 连接或授权。",
  read_only: "这个连接由项目配置管理，不能在这里修改。",
  conflict: "连接已被修改或删除，请刷新后重试。",
  busy: "请等待当前任务或连接操作完成后重试。",
  provider_rejected: "服务商未能验证凭证，请检查授权与访问权限。",
  cli_unavailable: "当前运行环境中没有可绑定的 CLI 登录，请先登录或使用 Token。",
  authorization_failed: "授权未完成，请重新开始。",
  authorization_expired: "授权已过期，请重新开始。",
  cancelled: "授权已取消。",
  unavailable: "Link 服务暂时不可用，请刷新后重试。",
};

export class LinkServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: LinkErrorCode,
  ) {
    super(messages[code]);
    this.name = "LinkServiceError";
  }
}

/** Trusted Host adapters use this to expose reviewed failure stages, never raw provider text. */
export class HostLinkOAuthError extends LinkServiceError {
  readonly failure: LinkAuthorizationFailure;
  constructor(failure: LinkAuthorizationFailure) {
    super(422, "authorization_failed");
    this.name = "HostLinkOAuthError";
    if (
      ![
        "invalid_request",
        "access_denied",
        "timeout",
        "network_error",
        "server_error",
        "protocol_error",
      ].includes(failure.code) ||
      ![
        "validation",
        "authorization",
        "discovery_registration",
        "authorization_callback",
        "token_exchange",
        "credential_verification",
      ].includes(failure.stage) ||
      (failure.verificationStage !== undefined &&
        ![
          "credential_binding",
          "mcp_initialize",
          "tool_discovery",
          "account_verification",
          "capability_verification",
        ].includes(failure.verificationStage)) ||
      (failure.reason !== undefined &&
        ![
          "binding_mismatch",
          "cancelled",
          "network_error",
          "http_error",
          "protocol_error",
          "tool_unavailable",
          "invalid_pagination",
          "response_too_large",
          "account_tool_error",
          "account_identity_unavailable",
          "no_read_capabilities",
        ].includes(failure.reason)) ||
      (failure.httpStatus !== undefined &&
        (!Number.isInteger(failure.httpStatus) ||
          failure.httpStatus < 400 ||
          failure.httpStatus > 599))
    )
      throw new LinkServiceError(400, "invalid_request");
    this.failure = Object.freeze({
      code: failure.code,
      stage: failure.stage,
      ...(failure.verificationStage ? { verificationStage: failure.verificationStage } : {}),
      ...(failure.reason ? { reason: failure.reason } : {}),
      ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
    });
  }
}

export function publicLinkError(error: unknown): LinkServiceError {
  if (error instanceof LinkServiceError) return error;
  const status = (error as { status?: unknown })?.status;
  return status === 409
    ? new LinkServiceError(409, "busy")
    : status === 401
      ? new LinkServiceError(401, "login_required")
      : new LinkServiceError(503, "unavailable");
}

export interface LinkServiceOptions {
  cwd?: string;
  store?: CredentialStore;
  withMutation?: <T>(write: () => Promise<T>) => Promise<T>;
  onChanged?: () => void | Promise<void>;
  now?: () => number;
  /** Trusted Host configuration; never accepted from a browser request. */
  remoteLink?: () => RemoteLinkConfiguration | undefined;
  /** Trusted Host opt-in: reuse a uniquely identified user connection after remote OAuth. */
  reuseRemoteConnection?: boolean;
  /** Test seams. Production delegates to Core's fixed provider and CLI executors. */
  validateToken?: typeof validateLocalLinkToken;
  cliStatus?: typeof getCliLinkStatus;
  bindCli?: typeof connectCliLink;
  createDeviceBroker?: () => LinkDeviceOAuthBroker;
  readRemoteCatalog?: typeof readRemoteProviderCatalog;
  /** Native Host only; remote browser callers may bind existing Host sessions but cannot start login. */
  allowCliLogin?: boolean;
  hostOAuthAdapters?: readonly HostLinkOAuthAdapter[];
  /** Defaults to redacted single-line JSON on stderr for HTTP and native authorization starts. */
  onAuthorizationDiagnostic?: LinkAuthorizationDiagnosticSink;
}

interface HostOAuthJob {
  context: LinkOperationContext;
  adapter: HostLinkOAuthAdapter;
  prepared: PreparedConnection;
  operation: ActiveOperation;
  public: LinkAuthorization;
  timer?: ReturnType<typeof setTimeout>;
  retireAt?: number;
  cancel?: (code: LinkErrorCode) => void;
}

/** Trusted host adapter input; deliberately absent from the HTTP API. */
export type ValidatedLinkAuthentication =
  | { source: "manual-token"; token: string }
  | { source: "browser-oauth"; token: LocalBrowserAuthToken }
  | { source: "cli-session" };

interface ActiveOperation {
  ownerId: string;
  controller: AbortController;
}
interface AuthorizationJob {
  ownerId: string;
  context: LinkOperationContext;
  broker: LinkDeviceOAuthBroker;
  brokerAttempt?: string;
  public: LinkAuthorization;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
  operation: ActiveOperation;
}
interface RemoteAuthorizationJob {
  context: LinkOperationContext;
  attempt: RemoteLinkAttempt;
  prepared: PreparedConnection;
  public: LinkAuthorization;
  completing: boolean;
  retireAt?: number;
}
interface InteractiveAuthorizationJob {
  context: LinkOperationContext;
  prepared: PreparedConnection;
  operation: ActiveOperation;
  public: LinkAuthorization;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
  busy: boolean;
  /** Identity actually shown for this step; labels are not stable account identifiers. */
  confirmedCliAccountId?: string;
}
type PreparedConnection = {
  input: LinkConnectionInput;
  id: string;
  expected: Credential | null;
};

/** One host/workspace credential domain. Browsers never provide the store or owner identity. */
export function createLinkService(options: LinkServiceOptions = {}) {
  const store = options.store ?? new CredentialStore(options.cwd);
  const now = options.now ?? Date.now;
  const validateToken = options.validateToken ?? validateLocalLinkToken;
  const cliStatus = options.cliStatus ?? getCliLinkStatus;
  const bindCli = options.bindCli ?? connectCliLink;
  const createBroker = options.createDeviceBroker ?? (() => new LinkDeviceOAuthBroker());
  const providers = listDesktopLinkProviders();
  const revisions = new Map<string, { signature: string; revision: string }>();
  const operations = new Set<ActiveOperation>();
  const jobs = new Map<string, AuthorizationJob>();
  const remoteJobs = new Map<string, RemoteAuthorizationJob>();
  const interactiveJobs = new Map<string, InteractiveAuthorizationJob>();
  const hostOAuthJobs = new Map<string, HostOAuthJob>();
  const hostOAuthAdapters = options.hostOAuthAdapters ?? [];
  let remoteCatalog:
    | {
        issuer: string;
        expiresAt: number;
        providers: RemoteProviderCapabilities[];
        health: NonNullable<LinkSnapshot["remoteCatalog"]>;
      }
    | undefined;
  type CatalogDiagnostic = {
    internalCode: LinkAuthorizationDiagnosticCode;
    upstreamStatus?: number;
  };
  const catalogPending = new Map<string, Promise<CatalogDiagnostic | undefined>>();
  const catalogCodes = new Map<string, LinkAuthorizationDiagnosticCode>([
    ["network", "catalog_network"],
    ["timeout", "catalog_timeout"],
    ["http_status", "catalog_http_status"],
    ["invalid_json", "catalog_invalid_json"],
    ["invalid_schema", "catalog_invalid_schema"],
    ["unreviewed_capability", "catalog_unreviewed_capability"],
    ["unsupported_auth", "catalog_unsupported_auth"],
    ["response_limit", "catalog_response_limit"],
  ]);
  const revokedOwners = new Set<string>();
  let closed = false;
  let snapshotSignature = "";
  let snapshotRevision = randomUUID();
  let cleanupRunning: Promise<void> | undefined;
  // One bounded, unref'd sweep per service. Store leases arbitrate other windows/processes.
  const cleanupTimer = setInterval(() => {
    void retryRemoteCleanup();
  }, 30_000);
  cleanupTimer.unref?.();
  const cleanupStartup = setTimeout(() => {
    void retryRemoteCleanup();
  }, 0);
  cleanupStartup.unref?.();
  function retryRemoteCleanup(): Promise<void> {
    if (closed) return Promise.resolve();
    if (cleanupRunning) return cleanupRunning;
    cleanupRunning = (async () => {
      if (!store.remoteLinkRetirementCount()) return;
      for (let count = 0; count < 8 && !closed; count++) {
        const claim = store.claimRemoteLinkRetirement(now());
        if (!claim) break;
        let success = false;
        try {
          await revokeRemoteLinkAuthorization(claim.credential);
          success = true;
        } catch {
          /* Keep private custody and retry with persisted backoff. */
        }
        store.finishRemoteLinkRetirement(claim, success, now());
      }
    })()
      .catch(() => {
        // A locked/unreadable store remains untouched; the next sweep retries. No secrets in logs.
      })
      .finally(() => {
        cleanupRunning = undefined;
      });
    return cleanupRunning;
  }

  function unavailable(context: LinkOperationContext): void {
    if (closed) throw new LinkServiceError(503, "unavailable");
    if (!context.ownerId || revokedOwners.has(context.ownerId))
      throw new LinkServiceError(401, "login_required");
  }
  async function authorize(context: LinkOperationContext): Promise<void> {
    try {
      unavailable(context);
      if (!(await context.authorize())) throw new LinkServiceError(401, "login_required");
      unavailable(context);
    } catch (error) {
      authorizationDiagnosticFailure("authorization", "authorization_check_failed");
      throw error;
    }
  }
  function begin(context: LinkOperationContext): ActiveOperation {
    unavailable(context);
    if (
      operations.size >= 8 ||
      [...operations].filter((operation) => operation.ownerId === context.ownerId).length >= 2
    ) {
      authorizationDiagnosticFailure("job_creation", "job_capacity_exceeded");
      throw new LinkServiceError(409, "busy");
    }
    const operation = { ownerId: context.ownerId, controller: new AbortController() };
    operations.add(operation);
    return operation;
  }
  function finish(operation: ActiveOperation): void {
    operations.delete(operation);
  }
  function revision(credential: Credential): string {
    const signature = createHash("sha256").update(JSON.stringify(credential)).digest("hex");
    let current = revisions.get(credential.id);
    if (current?.signature !== signature) {
      current = { signature, revision: randomUUID() };
      revisions.set(credential.id, current);
    }
    return current.revision;
  }
  function records() {
    authorizationDiagnosticStage("host_store_read");
    try {
      const current = store.listWithStatus("full");
      if (!current.readable) {
        authorizationDiagnosticFailure("host_store_read", "host_store_unreadable");
        throw new LinkServiceError(503, "unavailable");
      }
      return {
        credentials: current.credentials,
        projectIds: new Set(store.list("project").map((c) => c.id)),
      };
    } catch (error) {
      if (!(error instanceof LinkServiceError))
        authorizationDiagnosticFailure("host_store_read", "host_store_read_failed");
      throw error;
    }
  }
  function isLink(credential: Credential): boolean {
    return (
      isRemoteLinkCredential(credential) ||
      (credential.type === "link" &&
        linkConnectionMetadata(credential.meta).linkExecutionRuntime === "local" &&
        providers.some((provider) => provider.id === credential.meta?.linkProvider)) ||
      (credential.type === "oauth" &&
        linkConnectionMetadata(credential.meta).linkExecutionBackend === "mcp" &&
        linkConnectionMetadata(credential.meta).linkExecutionRuntime === "local" &&
        providers.some((provider) => provider.id === credential.meta?.linkProvider))
    );
  }
  function masked(credential: Credential, scope: "user" | "project"): MaskedLinkConnection {
    const meta = linkConnectionMetadata(credential.meta);
    const oauth =
      meta.linkAuthSource === "browser-oauth" || meta.linkAuthSource === "mcp-oauth"
        ? summarizeOAuthCredentialSecret(credential.secret)
        : undefined;
    const remote = isRemoteLinkCredential(credential);
    const status =
      (remote && meta.linkRemoteState !== "connected") ||
      ((meta.linkAuthSource === "browser-oauth" || meta.linkAuthSource === "mcp-oauth") &&
        meta.linkOAuthState &&
        meta.linkOAuthState !== "connected") ||
      ((meta.linkAuthSource === "browser-oauth" || meta.linkAuthSource === "mcp-oauth") &&
        meta.linkCapabilityIds?.length === 0)
        ? "unavailable"
        : !isCredentialSecretAvailable(credential.secret)
          ? "unavailable"
          : oauth?.state === "expired" && !oauth.canRefresh
            ? "expired"
            : oauth?.state === "invalid" || oauth?.state === "missing"
              ? "invalid"
              : "connected";
    return {
      id: credential.id,
      providerId: meta.linkProvider!,
      methodId: meta.linkConnectionMethod ?? "",
      label: credential.label,
      runtime: remote ? "server" : "local",
      authSource: remote
        ? "remote-link"
        : meta.linkExecutionBackend === "cli"
          ? "cli-session"
          : meta.linkAuthSource === "mcp-oauth"
            ? "mcp-oauth"
            : meta.linkAuthSource === "browser-oauth"
              ? "browser-oauth"
              : "manual-token",
      status,
      recipeId: meta.linkRecipeId,
      connectionState: {
        authorization: {
          state:
            status === "connected"
              ? "authorized"
              : status === "expired" ||
                  status === "invalid" ||
                  meta.linkRemoteState === "reconnect" ||
                  meta.linkOAuthState === "reconnect"
                ? "reauthorization_required"
                : "unknown",
        },
        // Compatibility is operation-specific. A saved grant or a successful
        // account check cannot prove the contract required by a future task.
        compatibility: { state: "unknown" },
        observation: { state: "unchecked" },
      },
      scope,
      editable: scope === "user",
      revision: revision(credential),
      account: {
        id: meta.linkAccountId,
        label: meta.linkAccountLabel,
        resources: meta.linkResourceLabels?.slice(0, 100) ?? [],
        ...(remote && meta.linkResourceGroups
          ? {
              resourceGroups: meta.linkResourceGroups.map((group) => ({
                id: group.id,
                items: group.items.map((item) => ({ id: item.id, label: item.label })),
              })),
            }
          : {}),
      },
      capabilityIds: meta.linkCapabilityIds ?? [],
      verifiedAt: meta.linkLastVerifiedAt,
      ...(oauth?.expiresAt ? { expiresAt: oauth.expiresAt } : {}),
    };
  }
  function snapshot(): LinkSnapshot {
    if (closed) throw new LinkServiceError(503, "unavailable");
    const current = records();
    const ids = new Set(current.credentials.map((credential) => credential.id));
    for (const id of revisions.keys()) if (!ids.has(id)) revisions.delete(id);
    const remoteConfig = remoteConfiguration();
    const remoteProviders = remoteConfig
      ? remoteCatalog?.issuer === remoteConfig.issuer
        ? remoteCatalog.providers
        : []
      : [];
    const catalogHealth: NonNullable<LinkSnapshot["remoteCatalog"]> = !remoteConfig
      ? { state: "unconfigured" }
      : remoteCatalog?.issuer === remoteConfig.issuer
        ? { ...remoteCatalog.health }
        : { state: "unknown" };
    const remoteReady = catalogHealth.state === "ready";
    const result = {
      providers: providers.map((provider) => {
        const deviceAuth = isLocalBrowserLinkProvider(provider.id)
          ? createBroker().status(provider.id)
          : undefined;
        const authModes: LinkAuthMode[] = [];
        for (const adapter of hostOAuthAdapters.filter((entry) => entry.providerId === provider.id))
          authModes.push({
            id: adapter.authModeId,
            methodId: adapter.methodId,
            kind: "redirect",
            label: adapter.label,
            preferred: true,
            available: true,
          });
        for (const method of provider.connectionMethods) {
          if (
            hostOAuthAdapters.some(
              (adapter) => adapter.providerId === provider.id && adapter.methodId === method.id,
            )
          )
            continue;
          if (method.oauthProfileId && method.browserAuth?.flow === "authorization-code-pkce")
            continue;
          if (method.executionRuntime !== "local" || method.availability !== "available") continue;
          if (method.browserAuth?.flow === "device-code")
            authModes.push({
              id: "browser-oauth",
              methodId: method.id,
              kind: "device-code",
              label: "网页授权",
              available: !!deviceAuth?.configured,
              preferred: !!deviceAuth?.configured,
              ...(!deviceAuth?.configured
                ? { unavailableReason: "当前 Host 未配置服务商授权。" }
                : {}),
            });
          if (method.quickAuth)
            authModes.push({
              id: "cli-session",
              methodId: method.id,
              kind: "local-session",
              label: "使用已有 CLI 登录",
              available: true,
            });
          authModes.push({
            id: "token",
            methodId: method.id,
            kind: "credential-input",
            label: method.tokenLabel ?? provider.tokenLabel,
            available: true,
            preferred: !deviceAuth?.configured,
          });
        }
        const remote = REMOTE_LINK_ADAPTERS.find(
          (adapter) =>
            adapter.id === provider.id &&
            (remoteProviders.some((remote) => remote.id === adapter.id) ||
              current.credentials.some(
                (credential) =>
                  isRemoteLinkCredential(credential) &&
                  credential.meta?.linkProvider === provider.id,
              )),
        );
        const remoteAvailable =
          remoteReady && remoteProviders.some((candidate) => candidate.id === provider.id);
        return {
          ...provider,
          connectionMethods: [
            ...provider.connectionMethods,
            ...(remote
              ? [
                  {
                    id: remote.methodId,
                    displayName: { zh: "服务器授权", en: "Server authorization" },
                    executionRuntime: "server" as const,
                    secretLocation: "server" as const,
                    authKind: "oauth" as const,
                    availability: "available" as const,
                  },
                ]
              : []),
          ],
          authModes: [
            ...(remote
              ? [
                  {
                    id: remote.authModeId,
                    methodId: remote.methodId,
                    kind: "redirect" as const,
                    label: "网页授权",
                    preferred: true,
                    available: remoteAvailable,
                    ...(!remoteAvailable
                      ? {
                          unavailableReason: !remoteConfig
                            ? "当前未配置 Link 服务。已有账号仍可管理。"
                            : remoteReady
                              ? "当前 Link 服务未提供此连接方式。已有账号仍可管理。"
                              : "连接目录暂时不可用。已有账号仍可管理，请稍后重试。",
                        }
                      : {}),
                  },
                ]
              : []),
            ...authModes,
          ],
          ...(deviceAuth ? { deviceAuth } : {}),
        };
      }),
      connections: current.credentials
        .filter(isLink)
        .map((credential) =>
          masked(credential, current.projectIds.has(credential.id) ? "project" : "user"),
        ),
      capabilities: {
        token: true,
        cliBinding: true,
        deviceAuth: true,
        remoteAuth: remoteReady && remoteProviders.length > 0,
        authorizationSteps: 1 as const,
      },
      ...(remoteConfig ? { remoteServer: { issuer: remoteConfig.issuer } } : {}),
      remoteCatalog: catalogHealth,
      remoteCleanupPending: store.remoteLinkRetirementCount(),
    };
    const signature = JSON.stringify(result);
    if (signature !== snapshotSignature) {
      snapshotSignature = signature;
      snapshotRevision = randomUUID();
    }
    return { ...result, revision: snapshotRevision };
  }
  function remoteConfiguration(): RemoteLinkConfiguration | undefined {
    authorizationDiagnosticStage("remote_configuration");
    try {
      return options.remoteLink?.();
    } catch (error) {
      authorizationDiagnosticFailure("remote_configuration", "remote_configuration_invalid");
      throw error;
    }
  }
  async function refreshRemoteCatalogWithDiagnostic(
    context: LinkOperationContext,
    force = false,
  ): Promise<CatalogDiagnostic | undefined> {
    await authorize(context);
    const config = remoteConfiguration();
    if (
      !config ||
      (!force && remoteCatalog?.issuer === config.issuer && remoteCatalog.expiresAt > now())
    )
      return;
    authorizationDiagnosticStage("remote_catalog");
    if (!catalogPending.has(config.issuer)) {
      const pending = (async () => {
        const previous = remoteCatalog?.issuer === config.issuer ? remoteCatalog : undefined;
        let available = previous?.providers ?? [];
        let health: NonNullable<LinkSnapshot["remoteCatalog"]>;
        let diagnostic: CatalogDiagnostic | undefined;
        try {
          available = options.readRemoteCatalog
            ? (await options.readRemoteCatalog(config)).flatMap((id) => {
                const adapter = REMOTE_LINK_ADAPTERS.find((item) => item.id === id);
                return adapter
                  ? [{ id, actions: [...adapter.actions], scopes: [...adapter.scopes] }]
                  : [];
              })
            : await readRemoteProviderCapabilities(config);
          const checkedAt = new Date(now()).toISOString();
          health = { state: "ready", checkedAt, lastSuccessAt: checkedAt };
        } catch (error) {
          diagnostic = {
            internalCode:
              error instanceof RemoteLinkCatalogError
                ? (catalogCodes.get(error.reason) ?? "catalog_unexpected_error")
                : "catalog_unexpected_error",
            ...(error instanceof RemoteLinkCatalogError
              ? { upstreamStatus: error.httpStatus }
              : {}),
          };
          // A failed discovery does not revoke saved accounts or erase the last good catalog.
          health = {
            state: previous?.health.lastSuccessAt ? "stale" : "unavailable",
            checkedAt: new Date(now()).toISOString(),
            ...(previous?.health.lastSuccessAt
              ? { lastSuccessAt: previous.health.lastSuccessAt }
              : {}),
            errorCode: error instanceof RemoteLinkCatalogError ? error.code : "network_error",
            ...(error instanceof RemoteLinkCatalogError && error.httpStatus !== undefined
              ? { httpStatus: error.httpStatus }
              : {}),
          };
        }
        if (!closed && options.remoteLink?.()?.issuer === config.issuer)
          remoteCatalog = {
            issuer: config.issuer,
            expiresAt: now() + (health.state === "ready" ? 60_000 : 15_000),
            providers: available,
            health,
          };
        return diagnostic;
      })().finally(() => {
        if (catalogPending.get(config.issuer) === pending) catalogPending.delete(config.issuer);
      });
      catalogPending.set(config.issuer, pending);
    }
    // The shared request performs no trace writes. Every waiter owns its failure correlation.
    const diagnostic = await catalogPending.get(config.issuer);
    if (diagnostic)
      authorizationDiagnosticFailure(
        "remote_catalog",
        diagnostic.internalCode,
        diagnostic.upstreamStatus,
      );
    await authorize(context);
    return diagnostic;
  }
  async function refreshRemoteCatalog(context: LinkOperationContext, force = false): Promise<void> {
    await refreshRemoteCatalogWithDiagnostic(context, force);
  }
  function string(value: unknown, max = 200): string {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > max ||
      /[\x00-\x1f\x7f]/.test(value)
    )
      throw new LinkServiceError(400, "invalid_request");
    return value.trim();
  }
  function safeId(value: unknown): string {
    const id = string(value, 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))
      throw new LinkServiceError(400, "invalid_request");
    return id;
  }
  function reviewed(id: string, expectedRevision: unknown): Credential {
    authorizationDiagnosticStage("connection_review");
    const current = records();
    authorizationDiagnosticStage("connection_review");
    const credential = current.credentials.find((entry) => entry.id === id);
    if (!credential || !isLink(credential)) throw new LinkServiceError(409, "conflict");
    if (current.projectIds.has(id)) throw new LinkServiceError(403, "read_only");
    if (revision(credential) !== string(expectedRevision, 64))
      throw new LinkServiceError(409, "conflict");
    return credential;
  }
  function prepare(
    raw: LinkConnectionInput,
    hostAdapter?: HostLinkOAuthAdapter,
  ): PreparedConnection {
    authorizationDiagnosticStage("input_validation");
    if (!raw || typeof raw !== "object") throw new LinkServiceError(400, "invalid_request");
    const input = {
      providerId: string(raw.providerId, 80),
      methodId: string(raw.methodId, 80),
      label: string(raw.label),
      expectedRevision: raw.expectedRevision,
      ...(raw.connectionId === undefined ? {} : { connectionId: safeId(raw.connectionId) }),
    };
    const method = providers
      .find((provider) => provider.id === input.providerId)
      ?.connectionMethods.find((candidate) => candidate.id === input.methodId);
    if (!method || method.executionRuntime !== "local" || method.availability !== "available")
      throw new LinkServiceError(400, "invalid_request");
    if (
      method.oauthProfileId &&
      method.browserAuth?.flow === "authorization-code-pkce" &&
      (!hostAdapter ||
        hostAdapter.providerId !== input.providerId ||
        hostAdapter.methodId !== input.methodId)
    )
      throw new LinkServiceError(400, "invalid_request");
    const id = input.connectionId ?? `link-${randomUUID()}`;
    authorizationDiagnosticStage("connection_review");
    let expected: Credential | null = null;
    if (input.expectedRevision === null) {
      const current = records();
      authorizationDiagnosticStage("connection_review");
      if (current.credentials.some((credential) => credential.id === id))
        throw new LinkServiceError(409, "conflict");
    } else {
      expected = reviewed(id, input.expectedRevision);
      if (
        expected.meta?.linkProvider !== input.providerId ||
        expected.meta.linkConnectionMethod !== input.methodId
      )
        throw new LinkServiceError(409, "conflict");
    }
    return { input, id, expected };
  }
  async function change<T>(
    context: LinkOperationContext,
    write: () => T,
    bypassBusy = false,
  ): Promise<T> {
    const action = async () => {
      await authorize(context);
      const result = write();
      await options.onChanged?.();
      return result;
    };
    const result =
      !bypassBusy && options.withMutation ? await options.withMutation(action) : await action();
    await authorize(context);
    return result;
  }
  function swap(
    prepared: PreparedConnection,
    next: Credential | null,
    retirement?: { retireExpected: boolean; adopt?: string; now: number },
  ): void {
    const current = records();
    if (current.projectIds.has(prepared.id)) throw new LinkServiceError(403, "read_only");
    if (
      !prepared.expected &&
      next?.meta?.linkAccountId &&
      current.credentials.some(
        (credential) =>
          credential.id !== prepared.id &&
          credential.meta?.linkProvider === next.meta?.linkProvider &&
          credential.meta?.linkConnectionMethod === next.meta?.linkConnectionMethod &&
          credential.meta?.linkAccountId === next.meta?.linkAccountId,
      )
    )
      throw new LinkServiceError(409, "conflict");
    if (!store.compareAndSwap("user", prepared.id, prepared.expected, next, retirement))
      throw new LinkServiceError(409, "conflict");
  }
  async function commit(
    context: LinkOperationContext,
    prepared: PreparedConnection,
    validation: LocalLinkValidationResult,
    secret: string,
    authSource: Exclude<MaskedLinkConnection["authSource"], "remote-link">,
    lifecycle:
      | {
          beforeCommit: () => void;
          onCommitted: (connection: MaskedLinkConnection) => void;
        }
      | undefined = undefined,
  ): Promise<MaskedLinkConnection> {
    const credential: Credential = {
      id: prepared.id,
      type: "link",
      label: prepared.input.label,
      secret,
      autoUseByAI: false,
      meta: {
        linkProvider: prepared.input.providerId,
        linkConnectionMethod: prepared.input.methodId,
        recordSchemaVersion: 2,
        linkRecipeId:
          authSource === "cli-session"
            ? "cli-session"
            : authSource === "browser-oauth"
              ? "api-oauth"
              : "api-token",
        agentExposable: false,
        linkAccountId: validation.identity.externalAccountId,
        linkAccountLabel: validation.identity.label,
        linkResourceLabels: validation.identity.resourceLabels,
        linkCapabilityIds: validation.capabilityIds,
        linkLastVerifiedAt: new Date(
          Math.max(
            Date.parse(validation.verifiedAt) || now(),
            (Date.parse(prepared.expected?.meta?.linkLastVerifiedAt ?? "") || 0) + 1,
          ),
        ).toISOString(),
      },
    };
    return change(context, () => {
      lifecycle?.beforeCommit();
      swap(prepared, credential);
      const connection = masked(credential, "user");
      lifecycle?.onCommitted(connection);
      return connection;
    });
  }
  function tokenSecret(token: LocalBrowserAuthToken): string {
    return JSON.stringify({
      version: 1,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt:
        token.expiresIn === undefined
          ? undefined
          : new Date(now() + token.expiresIn * 1000).toISOString(),
      refreshTokenExpiresAt:
        token.refreshTokenExpiresIn === undefined
          ? undefined
          : new Date(now() + token.refreshTokenExpiresIn * 1000).toISOString(),
      tokenType: token.tokenType,
      scope: token.scope,
      tokenEndpoint: token.tokenEndpoint,
      clientId: token.clientId,
    });
  }
  async function persistValidatedConnection(
    context: LinkOperationContext,
    input: LinkConnectionInput,
    validation: LocalLinkValidationResult,
    authentication: ValidatedLinkAuthentication,
  ): Promise<MaskedLinkConnection> {
    await authorize(context);
    const prepared = prepare(input);
    if (validation.providerId !== prepared.input.providerId)
      throw new LinkServiceError(400, "invalid_request");
    const provider = providers.find((entry) => entry.id === prepared.input.providerId)!;
    const method = provider.connectionMethods.find(
      (entry) => entry.id === prepared.input.methodId,
    )!;
    if (
      validation.capabilityIds.some(
        (id) => !provider.actions.some((action) => id === `${provider.id}.${action.id}`),
      )
    )
      throw new LinkServiceError(400, "invalid_request");
    if (authentication.source === "cli-session" && !method.quickAuth)
      throw new LinkServiceError(400, "invalid_request");
    if (
      authentication.source === "browser-oauth" &&
      (!method.browserAuth || authentication.token.providerId !== provider.id)
    )
      throw new LinkServiceError(400, "invalid_request");
    const secret =
      authentication.source === "cli-session"
        ? `cli-binding:${randomBytes(24).toString("base64url")}`
        : authentication.source === "browser-oauth"
          ? tokenSecret(authentication.token)
          : string(authentication.token, 16_384);
    return commit(context, prepared, validation, secret, authentication.source);
  }
  async function connectToken(
    context: LinkOperationContext,
    input: TokenConnectionInput,
  ): Promise<MaskedLinkConnection> {
    const operation = begin(context);
    try {
      await authorize(context);
      const prepared = prepare(input);
      const token = string(input.token, 16_384);
      let validation: LocalLinkValidationResult;
      try {
        validation = await validateToken(prepared.input.providerId, token, {
          signal: operation.controller.signal,
        });
      } catch {
        await authorize(context);
        throw new LinkServiceError(422, "provider_rejected");
      }
      await authorize(context);
      return await commit(context, prepared, validation, token, "manual-token");
    } finally {
      finish(operation);
    }
  }
  async function connectCli(
    context: LinkOperationContext,
    input: LinkConnectionInput,
  ): Promise<MaskedLinkConnection> {
    const operation = begin(context);
    try {
      await authorize(context);
      const prepared = prepare(input);
      const providerId = prepared.input.providerId;
      const method = providers
        .find((provider) => provider.id === providerId)
        ?.connectionMethods.find((candidate) => candidate.id === prepared.input.methodId);
      if (!isCliLinkProvider(providerId) || !method?.quickAuth)
        throw new LinkServiceError(400, "invalid_request");
      let validation: LocalLinkValidationResult;
      try {
        validation = await bindCli(providerId, {
          cwd: options.cwd,
          signal: operation.controller.signal,
          loginIfNeeded: false,
        });
      } catch {
        await authorize(context);
        throw new LinkServiceError(422, "cli_unavailable");
      }
      await authorize(context);
      return await commit(
        context,
        prepared,
        validation,
        `cli-binding:${randomBytes(24).toString("base64url")}`,
        "cli-session",
      );
    } finally {
      finish(operation);
    }
  }
  async function getCliStatus(context: LinkOperationContext, rawProviderId: unknown) {
    const operation = begin(context);
    try {
      await authorize(context);
      const providerId = string(rawProviderId, 80);
      if (!isCliLinkProvider(providerId)) throw new LinkServiceError(400, "invalid_request");
      const result = await cliStatus(providerId, {
        cwd: options.cwd,
        signal: operation.controller.signal,
      });
      await authorize(context);
      return {
        providerId,
        command: result.command,
        installed: result.installed,
        authenticated: result.authenticated,
        ...(result.account ? { account: result.account } : {}),
        ...(result.accountId ? { accountId: result.accountId } : {}),
      };
    } finally {
      finish(operation);
    }
  }
  async function rename(
    context: LinkOperationContext,
    id: string,
    label: string,
    expectedRevision: string,
  ) {
    await authorize(context);
    const credential = reviewed(safeId(id), expectedRevision);
    const replacement = { ...credential, label: string(label) };
    return change(context, () => {
      swap(
        { id: credential.id, expected: credential, input: {} as LinkConnectionInput },
        replacement,
      );
      return masked(replacement, "user");
    });
  }
  async function disconnect(context: LinkOperationContext, id: string, expectedRevision: string) {
    await authorize(context);
    const credential = reviewed(safeId(id), expectedRevision);
    if (linkConnectionMetadata(credential.meta).linkExecutionBackend === "mcp") {
      const adapter = hostOAuthAdapters.find(
        (entry) =>
          entry.providerId === credential.meta?.linkProvider &&
          entry.methodId === credential.meta?.linkConnectionMethod,
      );
      await change(
        context,
        () =>
          swap({ id: credential.id, expected: credential, input: {} as LinkConnectionInput }, null),
        true,
      );
      // Local authority is already gone. Cleanup never deletes a new connection with this ID.
      await adapter?.disconnect?.(credential).catch(() => {});
      return;
    }
    if (isRemoteLinkCredential(credential)) {
      // Disable local use before external I/O. Retain the disabled record if remote revocation
      // fails so the user can retry; never report successful remote revocation on a timeout.
      const disabled: Credential = {
        ...credential,
        meta: { ...credential.meta, linkRemoteState: "reconnect" },
      };
      await change(
        context,
        () =>
          swap(
            { id: credential.id, expected: credential, input: {} as LinkConnectionInput },
            disabled,
          ),
        true,
      );
      try {
        await revokeRemoteLinkAuthorization(disabled);
      } catch {
        throw new LinkServiceError(503, "unavailable");
      }
      await change(
        context,
        () =>
          swap({ id: credential.id, expected: disabled, input: {} as LinkConnectionInput }, null),
        true,
      );
      return;
    }
    // Revocation must work during an active action; the host's credential observer aborts it.
    await change(
      context,
      () =>
        swap({ id: credential.id, expected: credential, input: {} as LinkConnectionInput }, null),
      true,
    );
  }
  function terminal(
    value: LinkAuthorization,
    state: LinkAuthorization["state"],
    extra: Partial<LinkAuthorization> = {},
  ): LinkAuthorization {
    const { step: _step, prompt: _prompt, redirect: _redirect, errorCode: _error, ...rest } = value;
    return { ...rest, state, ...extra };
  }
  function endInteractive(job: InteractiveAuthorizationJob, code: LinkErrorCode): void {
    if (job.public.state !== "pending") return;
    job.operation.controller.abort();
    clearTimeout(job.timer);
    finish(job.operation);
    job.public = terminal(job.public, code === "cancelled" ? "cancelled" : "failed", {
      errorCode: code,
    });
    job.expiresAt = now() + 5 * 60_000;
  }
  function pruneInteractive(): void {
    for (const [id, job] of interactiveJobs) {
      if (job.expiresAt > now()) continue;
      if (job.public.state === "pending") endInteractive(job, "authorization_expired");
      else interactiveJobs.delete(id);
    }
  }
  function assertInteractivePending(job: InteractiveAuthorizationJob): void {
    if (job.public.state !== "pending" || job.operation.controller.signal.aborted)
      throw new LinkServiceError(409, "cancelled");
    if (job.expiresAt <= now()) throw new LinkServiceError(409, "authorization_expired");
  }
  function cliStep(
    job: InteractiveAuthorizationJob,
    expiresAt: string,
    installed: boolean,
    validation?: LocalLinkValidationResult,
    message?: string,
  ): LinkAuthorizationStep {
    if (
      validation &&
      (validation.providerId !== job.prepared.input.providerId ||
        typeof validation.identity.externalAccountId !== "string" ||
        !validation.identity.externalAccountId)
    )
      throw new LinkServiceError(422, "provider_rejected");
    job.confirmedCliAccountId = validation?.identity.externalAccountId;
    return {
      id: randomUUID(),
      kind: "local-session",
      expiresAt,
      session: {
        installed,
        authenticated: !!validation,
        canLogin: options.allowCliLogin === true && installed,
        canInstall: options.allowCliLogin === true,
        ...(validation ? { account: validation.identity.label } : {}),
        ...(message ? { message } : {}),
      },
    };
  }
  async function detectCliSession(
    job: InteractiveAuthorizationJob,
  ): Promise<LinkAuthorizationStep> {
    const providerId = job.prepared.input.providerId as Parameters<typeof cliStatus>[0];
    const status = await cliStatus(providerId, {
      cwd: options.cwd,
      signal: job.operation.controller.signal,
    });
    await authorize(job.context);
    assertInteractivePending(job);
    let validation: LocalLinkValidationResult | undefined;
    if (status.installed && status.authenticated) {
      try {
        validation = await bindCli(providerId, {
          cwd: options.cwd,
          signal: job.operation.controller.signal,
          loginIfNeeded: false,
        });
      } catch {
        // No identity has been confirmed; the user may log in or detect again.
      }
      await authorize(job.context);
      assertInteractivePending(job);
    }
    return cliStep(job, job.public.expiresAt!, status.installed, validation);
  }
  async function startHostOAuth(
    context: LinkOperationContext,
    input: LinkConnectionInput,
    adapter: HostLinkOAuthAdapter,
  ): Promise<LinkAuthorization> {
    authorizationDiagnosticStage("job_creation");
    for (const [id, job] of hostOAuthJobs)
      if (job.retireAt !== undefined && job.retireAt <= now()) hostOAuthJobs.delete(id);
    if (hostOAuthJobs.size >= 32) {
      authorizationDiagnosticFailure("job_creation", "job_capacity_exceeded");
      throw new LinkServiceError(409, "busy");
    }
    const prepared = prepare(input, adapter);
    authorizationDiagnosticStage("job_creation");
    const operation = begin(context);
    const expiresAt = new Date(now() + 10 * 60_000).toISOString();
    const job: HostOAuthJob = {
      context,
      adapter,
      prepared,
      operation,
      public: {
        id: randomUUID(),
        providerId: input.providerId,
        methodId: input.methodId,
        authModeId: adapter.authModeId,
        state: "pending",
        expiresAt,
        step: { id: randomUUID(), kind: "processing", expiresAt },
      },
    };
    hostOAuthJobs.set(job.public.id, job);
    let ready!: () => void;
    const preparedStep = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const end = (code: LinkErrorCode) => {
      if (job.public.state !== "pending") return;
      operation.controller.abort();
      job.public = terminal(job.public, code === "cancelled" ? "cancelled" : "failed", {
        errorCode: code,
      });
      job.retireAt = now() + 5 * 60_000;
      clearTimeout(job.timer);
      ready();
    };
    job.cancel = end;
    const onAbort = () => end("cancelled");
    context.signal?.addEventListener("abort", onAbort, { once: true });
    job.timer = setTimeout(() => end("authorization_expired"), 10 * 60_000);
    job.timer.unref?.();
    if (context.signal?.aborted) end("cancelled");
    void (async () => {
      let candidate: Credential | undefined;
      let committed = false;
      try {
        operation.controller.signal.throwIfAborted();
        candidate = await adapter.authorize({
          id: prepared.id,
          label: prepared.input.label,
          previous: prepared.expected,
          signal: operation.controller.signal,
          onAuthorizationUrl: async (url, expiry) => {
            await authorize(context);
            operation.controller.signal.throwIfAborted();
            const target = new URL(url);
            const time = Date.parse(expiry);
            if (
              target.protocol !== "https:" ||
              target.username ||
              target.password ||
              target.hash ||
              !Number.isFinite(time) ||
              time <= now() ||
              time > now() + 10 * 60_000 + 1_000
            )
              throw new LinkServiceError(422, "authorization_failed");
            if (job.public.state !== "pending") throw new LinkServiceError(409, "cancelled");
            job.public.expiresAt = expiry;
            clearTimeout(job.timer);
            job.timer = setTimeout(() => end("authorization_expired"), Math.max(1, time - now()));
            job.timer.unref?.();
            job.public.step = {
              id: randomUUID(),
              kind: "redirect",
              expiresAt: expiry,
              authorizationUrl: target.href,
            };
            ready();
          },
        });
        await authorize(context);
        operation.controller.signal.throwIfAborted();
        if (
          job.public.state !== "pending" ||
          candidate.id !== prepared.id ||
          candidate.type !== "oauth" ||
          candidate.meta?.linkProvider !== input.providerId ||
          candidate.meta.linkConnectionMethod !== input.methodId ||
          linkConnectionMetadata(candidate.meta).linkExecutionBackend !== "mcp" ||
          candidate.meta.agentExposable !== false
        )
          throw new LinkServiceError(422, "provider_rejected");
        // Host adapters may still return legacy routing fields. The installed
        // connection keeps only its reviewed recipe; presentation derives axes.
        const {
          linkExecutionRuntime: _runtime,
          linkExecutionBackend: _backend,
          linkAuthSource: _source,
          ...candidateMeta
        } = candidate.meta!;
        candidate = {
          ...candidate,
          meta: { ...candidateMeta, recordSchemaVersion: 2, linkRecipeId: "mcp-oauth" },
        };
        await change(context, () => {
          operation.controller.signal.throwIfAborted();
          if (job.public.state !== "pending") throw new LinkServiceError(409, "cancelled");
          swap(prepared, candidate!);
          committed = true;
          job.public = terminal(job.public, "connected", {
            connection: masked(candidate!, "user"),
          });
        });
      } catch (error) {
        if (job.public.state === "pending") {
          end(
            operation.controller.signal.aborted
              ? "cancelled"
              : error instanceof LinkServiceError
                ? error.code
                : "authorization_failed",
          );
          if (
            (job.public as LinkAuthorization).state === "failed" &&
            error instanceof HostLinkOAuthError
          )
            job.public = { ...job.public, failure: { ...error.failure } };
        }
      } finally {
        if (candidate?.secret && !committed) {
          try {
            const saved = store.resolve(candidate.id, "full");
            if (
              candidate.secret !== prepared.expected?.secret &&
              candidate.secret !== saved?.secret
            )
              await adapter.disconnect?.(candidate);
          } catch {
            /* Detached cleanup cannot change the original authorization result. */
          }
        }
        clearTimeout(job.timer);
        context.signal?.removeEventListener("abort", onAbort);
        job.retireAt = now() + 5 * 60_000;
        finish(operation);
        ready();
      }
    })();
    await preparedStep;
    return structuredClone(job.public);
  }

  async function openHostAuthorization(
    context: LinkOperationContext,
    id: string,
  ): Promise<boolean> {
    await authorize(context);
    const job = hostOAuthJobs.get(safeId(id));
    if (!job) return false;
    if (
      job.context.ownerId !== context.ownerId ||
      job.public.state !== "pending" ||
      job.operation.controller.signal.aborted ||
      job.public.step?.kind !== "redirect" ||
      Date.parse(job.public.step.expiresAt) <= now()
    )
      throw new LinkServiceError(409, "conflict");
    const target = new URL(job.public.step.authorizationUrl);
    if (target.protocol !== "https:" || target.username || target.password || target.hash)
      throw new LinkServiceError(400, "invalid_request");
    await job.adapter.openAuthorizationUrl(target.href);
    await authorize(context);
    return true;
  }

  function diagnosticIdentity(input: LinkConnectionInput, authModeId: unknown): void {
    const provider = providers.find((candidate) => candidate.id === input?.providerId);
    if (!provider) return;
    const remote = REMOTE_LINK_ADAPTERS.find(
      (adapter) => adapter.id === provider.id && adapter.methodId === input.methodId,
    );
    const method = provider.connectionMethods.find((candidate) => candidate.id === input.methodId);
    const modes = remote
      ? [remote.authModeId]
      : method
        ? [
            "token",
            ...(method.quickAuth ? ["cli-session"] : []),
            ...(method.browserAuth?.flow === "device-code" ? ["browser-oauth"] : []),
            ...(method.oauthProfileId ? ["mcp-oauth"] : []),
          ]
        : [];
    authorizationDiagnosticIdentity({
      providerId: provider.id,
      ...(remote || method ? { methodId: remote?.methodId ?? method!.id } : {}),
      ...(modes.includes(authModeId as string) ? { authModeId: authModeId as string } : {}),
    });
  }
  async function startAuthorization(
    context: LinkOperationContext,
    input: LinkConnectionInput,
    rawAuthModeId: unknown,
  ): Promise<LinkAuthorization> {
    return withLinkAuthorizationTrace(
      options.onAuthorizationDiagnostic,
      () => startAuthorizationWithinTrace(context, input, rawAuthModeId),
      publicLinkError,
    );
  }
  async function startAuthorizationWithinTrace(
    context: LinkOperationContext,
    input: LinkConnectionInput,
    rawAuthModeId: unknown,
  ): Promise<LinkAuthorization> {
    await authorize(context);
    diagnosticIdentity(input, rawAuthModeId);
    authorizationDiagnosticStage("input_validation");
    const authModeId = string(rawAuthModeId, 80);
    const hostAdapter = hostOAuthAdapters.find(
      (adapter) =>
        adapter.providerId === input?.providerId &&
        adapter.methodId === input.methodId &&
        adapter.authModeId === authModeId,
    );
    if (input?.resourceUrl !== undefined && authModeId !== "remote-link" && !hostAdapter)
      throw new LinkServiceError(400, "invalid_request");
    if (authModeId === "remote-link") {
      const diagnostic = await refreshRemoteCatalogWithDiagnostic(context, true);
      const state = snapshot().remoteCatalog?.state;
      if (state !== "ready") {
        if (state === "unconfigured")
          authorizationDiagnosticFailure("remote_configuration", "remote_configuration_missing");
        else
          authorizationDiagnosticFailure(
            "remote_catalog",
            diagnostic?.internalCode ?? "catalog_unavailable",
            diagnostic?.upstreamStatus,
          );
        throw new LinkServiceError(503, "unavailable");
      }
    }
    const provider = snapshot().providers.find((candidate) => candidate.id === input?.providerId);
    authorizationDiagnosticStage("mode_selection");
    const mode = provider?.authModes?.find(
      (candidate) =>
        candidate.id === authModeId && candidate.methodId === input.methodId && candidate.available,
    );
    if (!mode) {
      authorizationDiagnosticFailure(
        "mode_selection",
        authModeId === "remote-link" &&
          REMOTE_LINK_ADAPTERS.some((adapter) => adapter.id === input?.providerId) &&
          !remoteCatalog?.providers.some((candidate) => candidate.id === input.providerId)
          ? "provider_capability_missing"
          : "auth_mode_unavailable",
      );
      throw new LinkServiceError(400, "invalid_request");
    }
    if (hostAdapter) return startHostOAuth(context, input, hostAdapter);
    if (mode.kind === "redirect") {
      const result = await startRemoteAuthAfterCatalog(context, input);
      const job = remoteJobs.get(result.id)!;
      job.public.methodId = input.methodId;
      job.public.authModeId = authModeId;
      job.public.expiresAt = result.redirect!.expiresAt;
      job.public.step = { id: randomUUID(), kind: "redirect", ...result.redirect! };
      return structuredClone(job.public);
    }
    if (mode.kind === "device-code") return startDeviceAuth(context, input);
    authorizationDiagnosticStage("job_creation");
    pruneInteractive();
    if (interactiveJobs.size >= 32) {
      authorizationDiagnosticFailure("job_creation", "job_capacity_exceeded");
      throw new LinkServiceError(409, "busy");
    }
    const prepared = prepare(input);
    authorizationDiagnosticStage("job_creation");
    const operation = begin(context);
    const expiresAt = now() + 10 * 60_000;
    const base = { id: randomUUID(), expiresAt: new Date(expiresAt).toISOString() };
    const step: LinkAuthorizationStep =
      mode.kind === "credential-input"
        ? {
            ...base,
            kind: "credential-input",
            purpose: "credential",
            fields: [
              {
                id: "token",
                label: provider!.tokenLabel,
                secret: true,
                required: true,
                placeholder: provider!.tokenPlaceholder,
                maxLength: 16_384,
              },
            ],
          }
        : {
            ...base,
            kind: "local-session",
            session: {
              installed: false,
              authenticated: false,
              canInstall: options.allowCliLogin === true,
            },
          };
    const job: InteractiveAuthorizationJob = {
      context,
      prepared,
      operation,
      expiresAt,
      busy: false,
      public: {
        id: randomUUID(),
        providerId: prepared.input.providerId,
        methodId: input.methodId,
        authModeId,
        expiresAt: base.expiresAt,
        state: "pending",
        step,
      },
    };
    interactiveJobs.set(job.public.id, job);
    job.timer = setTimeout(
      () => endInteractive(job, "authorization_expired"),
      Math.max(1, expiresAt - now()),
    );
    job.timer.unref?.();
    try {
      if (step.kind === "local-session") job.public.step = await detectCliSession(job);
      await authorize(context);
      assertInteractivePending(job);
      return structuredClone(job.public);
    } catch (error) {
      endInteractive(job, error instanceof LinkServiceError ? error.code : "cli_unavailable");
      throw publicLinkError(error);
    }
  }
  async function respondAuthorization(
    context: LinkOperationContext,
    id: string,
    response: LinkAuthorizationResponse,
  ): Promise<LinkAuthorization> {
    await authorize(context);
    pruneInteractive();
    const job = interactiveJobs.get(safeId(id));
    if (!job || job.context.ownerId !== context.ownerId)
      throw new LinkServiceError(404, "not_found");
    await authorize(job.context);
    if (job.public.state !== "pending" || job.busy) throw new LinkServiceError(409, "conflict");
    const step = job.public.step!;
    if (!response || response.stepId !== step.id || Date.parse(step.expiresAt) <= now())
      throw new LinkServiceError(409, "conflict");
    if (Object.keys(response).some((key) => !["stepId", "operation", "input"].includes(key)))
      throw new LinkServiceError(400, "invalid_request");
    if (
      response.input !== undefined &&
      (!response.input || typeof response.input !== "object" || Array.isArray(response.input))
    )
      throw new LinkServiceError(400, "invalid_request");
    let token: string | undefined;
    if (step.kind === "credential-input") {
      if (
        response.operation !== "submit" ||
        !response.input ||
        Object.keys(response.input).some((key) => key !== "token")
      )
        throw new LinkServiceError(400, "invalid_request");
      token = string(response.input.token, 16_384);
    } else if (
      step.kind !== "local-session" ||
      !["detect-session", "login-session", "bind-session"].includes(response.operation) ||
      Object.keys(response.input ?? {}).length
    )
      throw new LinkServiceError(400, "invalid_request");
    if (response.operation === "login-session" && options.allowCliLogin !== true)
      throw new LinkServiceError(400, "invalid_request");
    if (
      response.operation === "bind-session" &&
      (step.kind !== "local-session" || !step.session.authenticated || !job.confirmedCliAccountId)
    )
      throw new LinkServiceError(400, "invalid_request");
    job.busy = true;
    job.public = {
      ...job.public,
      errorCode: undefined,
      step: { id: randomUUID(), kind: "processing", expiresAt: step.expiresAt },
    };
    let committed = false;
    const check = async () => {
      await authorize(context);
      if (!committed) {
        await authorize(job.context);
        assertInteractivePending(job);
      }
      return true;
    };
    try {
      if (response.operation === "detect-session") {
        job.public.step = await detectCliSession(job);
        await check();
      } else if (response.operation === "login-session") {
        let validation: LocalLinkValidationResult;
        try {
          validation = await bindCli(
            job.prepared.input.providerId as Parameters<typeof bindCli>[0],
            { cwd: options.cwd, signal: job.operation.controller.signal, loginIfNeeded: true },
          );
        } catch {
          await check();
          throw new LinkServiceError(422, "cli_unavailable");
        }
        await check();
        job.public.step = cliStep(job, step.expiresAt, true, validation);
      } else {
        let validation: LocalLinkValidationResult;
        try {
          validation =
            token !== undefined
              ? await validateToken(job.prepared.input.providerId, token, {
                  signal: job.operation.controller.signal,
                })
              : await bindCli(job.prepared.input.providerId as Parameters<typeof bindCli>[0], {
                  cwd: options.cwd,
                  signal: job.operation.controller.signal,
                  loginIfNeeded: false,
                });
        } catch {
          await check();
          throw new LinkServiceError(
            422,
            token !== undefined ? "provider_rejected" : "cli_unavailable",
          );
        }
        await check();
        if (validation.providerId !== job.prepared.input.providerId)
          throw new LinkServiceError(422, "provider_rejected");
        if (
          token === undefined &&
          validation.identity.externalAccountId !== job.confirmedCliAccountId
        ) {
          job.public.step = cliStep(
            job,
            step.expiresAt,
            true,
            validation,
            "CLI 已切换账号，请确认当前账号后继续。",
          );
        } else {
          await commit(
            { ownerId: context.ownerId, authorize: check },
            job.prepared,
            validation,
            token ?? `cli-binding:${randomBytes(24).toString("base64url")}`,
            token !== undefined ? "manual-token" : "cli-session",
            {
              beforeCommit: () => assertInteractivePending(job),
              onCommitted: (connection) => {
                committed = true;
                job.public = terminal(job.public, "connected", { connection });
                clearTimeout(job.timer);
                finish(job.operation);
                job.expiresAt = now() + 5 * 60_000;
              },
            },
          );
        }
      }
      await authorize(context);
      return structuredClone(job.public);
    } catch (error) {
      if (job.public.state === "pending") {
        const code = error instanceof LinkServiceError ? error.code : "unavailable";
        if (
          ["provider_rejected", "cli_unavailable"].includes(code) &&
          !job.operation.controller.signal.aborted &&
          job.expiresAt > now()
        )
          job.public = { ...job.public, step: { ...step, id: randomUUID() }, errorCode: code };
        else endInteractive(job, code);
      }
      await authorize(context);
      return structuredClone(job.public);
    } finally {
      job.busy = false;
    }
  }
  function cancelJob(job: AuthorizationJob): void {
    job.operation.controller.abort();
    if (job.brokerAttempt) job.broker.cancel(job.brokerAttempt);
    if (job.timer) clearTimeout(job.timer);
    if (job.public.state === "pending")
      job.public = terminal(job.public, "cancelled", { errorCode: "cancelled" });
    finish(job.operation);
    job.expiresAt = now() + 5 * 60_000;
  }
  function expireJob(job: AuthorizationJob): void {
    if (job.public.state !== "pending") return;
    cancelJob(job);
    job.public = terminal(job.public, "failed", { errorCode: "authorization_expired" });
  }
  function pruneJobs(): void {
    for (const [id, job] of jobs)
      if (job.expiresAt <= now()) {
        if (job.public.state === "pending") expireJob(job);
        else jobs.delete(id);
      }
  }
  async function completeDevice(
    job: AuthorizationJob,
    prepared: PreparedConnection,
  ): Promise<void> {
    let committed = false;
    const assertPending = () => {
      if (job.public.state !== "pending" || job.operation.controller.signal.aborted)
        throw new LinkServiceError(409, "cancelled");
      if (job.expiresAt <= now()) throw new LinkServiceError(409, "authorization_expired");
    };
    const check = async () => {
      if (!committed) {
        await authorize(job.context);
        assertPending();
      }
      return true;
    };
    try {
      const token = await job.broker.complete(job.brokerAttempt!);
      await check();
      if (token.providerId !== prepared.input.providerId)
        throw new LinkServiceError(422, "authorization_failed");
      const validation = await validateToken(token.providerId, token.accessToken, {
        signal: job.operation.controller.signal,
        authKind: "oauth",
      });
      await check();
      await commit(
        { ownerId: job.context.ownerId, authorize: check },
        prepared,
        validation,
        tokenSecret(token),
        "browser-oauth",
        {
          beforeCommit: assertPending,
          onCommitted: (connection) => {
            committed = true;
            job.public = terminal(job.public, "connected", { connection });
            clearTimeout(job.timer);
            finish(job.operation);
            job.expiresAt = now() + 5 * 60_000;
          },
        },
      );
    } catch (error) {
      if (job.public.state === "pending")
        job.public = terminal(job.public, "failed", {
          errorCode: error instanceof LinkServiceError ? error.code : "authorization_failed",
        });
    } finally {
      if (job.timer) clearTimeout(job.timer);
      job.expiresAt = now() + 5 * 60_000;
      finish(job.operation);
    }
  }
  async function startDeviceAuth(
    context: LinkOperationContext,
    input: LinkConnectionInput,
  ): Promise<LinkAuthorization> {
    authorizationDiagnosticStage("job_creation");
    pruneJobs();
    if (jobs.size >= 32) {
      authorizationDiagnosticFailure("job_creation", "job_capacity_exceeded");
      throw new LinkServiceError(409, "busy");
    }
    const operation = begin(context);
    let job: AuthorizationJob | undefined;
    try {
      await authorize(context);
      const prepared = prepare(input);
      authorizationDiagnosticStage("job_creation");
      const providerId = prepared.input.providerId;
      if (!isLocalBrowserLinkProvider(providerId))
        throw new LinkServiceError(400, "invalid_request");
      const broker = createBroker();
      if (!broker.status(providerId).configured)
        throw new LinkServiceError(422, "authorization_failed");
      const id = randomUUID();
      job = {
        ownerId: context.ownerId,
        context,
        broker,
        public: {
          id,
          providerId,
          methodId: input.methodId,
          authModeId: "browser-oauth",
          state: "pending",
        },
        expiresAt: now() + 30 * 60_000,
        operation,
      };
      jobs.set(id, job);
      const prompt: LocalBrowserAuthPrompt = await broker.start(
        providerId,
        operation.controller.signal,
      );
      job.brokerAttempt = prompt.attemptId;
      await authorize(context);
      if (operation.controller.signal.aborted) throw new LinkServiceError(409, "cancelled");
      job.expiresAt = Date.parse(prompt.expiresAt);
      job.public.prompt = {
        userCode: prompt.userCode,
        verificationUri: prompt.verificationUri,
        verificationUriComplete: prompt.verificationUriComplete,
        expiresAt: prompt.expiresAt,
      };
      job.public.expiresAt = prompt.expiresAt;
      job.public.step = { id: randomUUID(), kind: "device-code", ...job.public.prompt };
      job.timer = setTimeout(
        () => expireJob(job!),
        Math.max(1, Math.min(30 * 60_000, job.expiresAt - now())),
      );
      job.timer.unref?.();
      const result = structuredClone(job.public);
      void completeDevice(job, prepared);
      return result;
    } catch (error) {
      if (job) {
        cancelJob(job);
        jobs.delete(job.public.id);
      }
      finish(operation);
      throw publicLinkError(error);
    }
  }
  function pruneRemoteJobs(): void {
    for (const [id, job] of remoteJobs) {
      if (job.attempt.expiresAt > now() && !job.retireAt) continue;
      if (!job.public.authModeId) {
        remoteJobs.delete(id);
        continue;
      }
      if (job.public.state === "pending")
        job.public = terminal(job.public, "failed", { errorCode: "authorization_expired" });
      job.retireAt ??= now() + 5 * 60_000;
      if (job.retireAt <= now()) remoteJobs.delete(id);
    }
  }
  async function startRemoteAuth(
    context: LinkOperationContext,
    input: LinkConnectionInput,
  ): Promise<LinkAuthorization> {
    await refreshRemoteCatalog(context, true);
    return startRemoteAuthAfterCatalog(context, input);
  }
  async function startRemoteAuthAfterCatalog(
    context: LinkOperationContext,
    input: LinkConnectionInput,
  ): Promise<LinkAuthorization> {
    await authorize(context);
    authorizationDiagnosticStage("job_creation");
    const checkCapacity = () => {
      pruneRemoteJobs();
      if (
        remoteJobs.size >= 32 ||
        [...remoteJobs.values()].filter(
          (job) => job.context.ownerId === context.ownerId && job.public.state === "pending",
        ).length >= 2
      ) {
        authorizationDiagnosticFailure("job_creation", "job_capacity_exceeded");
        throw new LinkServiceError(409, "busy");
      }
    };
    checkCapacity();
    authorizationDiagnosticStage("input_validation");
    if (
      !input ||
      input.methodId !== "remote-link" ||
      !REMOTE_LINK_ADAPTERS.some((adapter) => adapter.id === input.providerId) ||
      (input.resourceUrl !== undefined &&
        (input.providerId !== "figma" ||
          typeof input.resourceUrl !== "string" ||
          !input.resourceUrl))
    )
      throw new LinkServiceError(400, "invalid_request");
    const config = remoteConfiguration();
    if (!config) {
      authorizationDiagnosticFailure("remote_configuration", "remote_configuration_missing");
      throw new LinkServiceError(503, "unavailable");
    }
    // No await between selecting the deployment and creating its authorization URL.
    authorizationDiagnosticStage("remote_catalog");
    const capabilities =
      remoteCatalog?.issuer === config.issuer && remoteCatalog.health.state === "ready"
        ? remoteCatalog.providers.find((provider) => provider.id === input.providerId)
        : undefined;
    if (!capabilities) {
      authorizationDiagnosticFailure("remote_catalog", "provider_capability_missing");
      throw new LinkServiceError(503, "unavailable");
    }
    authorizationDiagnosticStage("connection_review");
    const id =
      input.connectionId === undefined ? `link-remote-${randomUUID()}` : safeId(input.connectionId);
    let expected: Credential | null = null;
    if (input.expectedRevision === null) {
      const current = records();
      authorizationDiagnosticStage("connection_review");
      if (current.credentials.some((credential) => credential.id === id))
        throw new LinkServiceError(409, "conflict");
    } else {
      expected = reviewed(id, input.expectedRevision);
      if (!isRemoteLinkCredential(expected) || expected.meta?.linkProvider !== input.providerId)
        throw new LinkServiceError(409, "conflict");
    }
    const prepared = { id, expected, input: { ...input, label: string(input.label) } };
    authorizationDiagnosticStage("job_creation");
    let attempt: RemoteLinkAttempt;
    try {
      let resourceFiles: string[] | undefined;
      if (input.providerId === "figma") {
        // A first connection may select the pasted file in the same OAuth consent.
        // Existing files still come exclusively from Host custody; input suggests one new file.
        const groups = expected?.meta?.linkResourceGroups;
        if (expected && (!groups || groups.length !== 1 || groups[0]?.id !== "files"))
          throw new Error("Invalid saved Figma resources");
        resourceFiles = groups?.[0]?.items.map((item) => item.id) ?? [];
        if (input.resourceUrl !== undefined) resourceFiles.push(input.resourceUrl);
      }
      attempt = beginRemoteLinkAuthorization(config, now(), {
        providerId: input.providerId,
        actions: capabilities.actions,
        ...(resourceFiles !== undefined ? { resourceFiles } : {}),
      });
    } catch {
      authorizationDiagnosticFailure("job_creation", "remote_authorization_invalid");
      throw new LinkServiceError(400, "invalid_request");
    }
    const publicJob: LinkAuthorization = {
      id: randomUUID(),
      providerId: input.providerId,
      state: "pending",
      redirect: {
        authorizationUrl: attempt.authorizationUrl,
        expiresAt: new Date(attempt.expiresAt).toISOString(),
      },
    };
    remoteJobs.set(publicJob.id, {
      context,
      attempt,
      prepared,
      public: publicJob,
      completing: false,
    });
    return structuredClone(publicJob);
  }
  async function completeRemoteAuth(
    context: LinkOperationContext,
    id: string,
    callbackUrl: string,
  ): Promise<LinkAuthorization> {
    await authorize(context);
    pruneRemoteJobs();
    const job = remoteJobs.get(safeId(id));
    if (!job || job.context.ownerId !== context.ownerId)
      throw new LinkServiceError(404, "not_found");
    if (job.completing || job.public.state !== "pending")
      throw new LinkServiceError(409, "conflict");
    const originalConfig = JSON.stringify(job.attempt.configuration);
    let committed = false;
    const assertPending = () => {
      if (remoteJobs.get(id) !== job || job.public.state !== "pending")
        throw new LinkServiceError(409, "cancelled");
      if (job.attempt.expiresAt <= now()) throw new LinkServiceError(409, "authorization_expired");
      const config = options.remoteLink?.();
      if (
        !config ||
        JSON.stringify(beginRemoteLinkAuthorization(config, now()).configuration) !== originalConfig
      )
        throw new LinkServiceError(409, "conflict");
    };
    const check = async () => {
      if (!committed) {
        await authorize(context);
        await authorize(job.context);
        assertPending();
      }
    };
    job.completing = true;
    let credential: Credential | undefined;
    let staged: string | undefined;
    try {
      await check();
      credential = await completeRemoteLinkAuthorization(
        job.attempt,
        string(callbackUrl, 16_384),
        job.prepared.id,
        job.prepared.input.label,
        {
          now: now(),
          onTokens: (minted) => {
            credential = minted;
            staged = store.stageRemoteLinkRetirement(minted, job.attempt.expiresAt + 60_000);
          },
        },
      );
      await check();
      if (
        job.attempt.providerId === "figma" &&
        job.prepared.expected &&
        credential.meta?.linkAccountId !== job.prepared.expected.meta?.linkAccountId
      )
        throw new LinkServiceError(409, "conflict");
      const guarded = {
        ownerId: context.ownerId,
        authorize: async () => {
          await check();
          return true;
        },
      };
      await change(guarded, () => {
        assertPending();
        let prepared = job.prepared;
        if (
          options.reuseRemoteConnection &&
          !prepared.expected &&
          prepared.input.connectionId === undefined
        ) {
          // Identity comes from authenticated metadata, never a browser-supplied connection ID.
          const current = records();
          const matches = current.credentials.filter(
            (entry) =>
              !current.projectIds.has(entry.id) &&
              isRemoteLinkCredential(entry) &&
              entry.meta?.linkProvider === credential!.meta?.linkProvider &&
              entry.meta?.linkRemoteIssuer === credential!.meta?.linkRemoteIssuer &&
              entry.meta?.linkRemoteConnectionId === credential!.meta?.linkRemoteConnectionId,
          );
          if (matches.length > 1) throw new LinkServiceError(409, "conflict");
          if (matches.length === 1) {
            const expected = matches[0]!;
            if (credential!.meta?.linkProvider === "figma") {
              const oldGroups = expected.meta?.linkResourceGroups;
              const newGroups = credential!.meta?.linkResourceGroups;
              // A concurrent first connection never reviewed this saved grant.
              // Reuse only when the newly minted authority already covers it;
              // a local union cannot expand the remote token's file whitelist.
              if (
                expected.meta?.linkAccountId !== credential!.meta?.linkAccountId ||
                oldGroups?.length !== 1 ||
                oldGroups[0]?.id !== "files" ||
                newGroups?.length !== 1 ||
                newGroups[0]?.id !== "files" ||
                oldGroups[0].items.some(
                  (item) => !newGroups[0].items.some((next) => next.id === item.id),
                ) ||
                expected.meta?.linkCapabilityIds?.some(
                  (id) => !credential!.meta?.linkCapabilityIds?.includes(id),
                )
              )
                throw new LinkServiceError(409, "conflict");
            }
            prepared = { ...prepared, id: expected.id, expected };
            credential = { ...credential!, id: expected.id, label: expected.label };
          }
        }
        swap(prepared, credential!, {
          retireExpected: !!prepared.expected,
          adopt: staged,
          now: now(),
        });
        const connection = masked(credential!, "user");
        committed = true;
        job.public = terminal(job.public, "connected", { connection });
      });
      // Replacing the active record and retaining its previous grant is one atomic write.
      await retryRemoteCleanup();
      if (store.remoteLinkRetirementCount()) job.public.previousGrantRevocationPending = true;
      await authorize(context);
      return structuredClone(job.public);
    } catch (error) {
      if (committed) {
        // Notification or post-write authorization failure cannot revoke an adopted grant.
        await authorize(context);
        return structuredClone(job.public);
      }
      // If the callback minted a grant but its destination changed, do not leave it usable remotely.
      if (staged) {
        store.readyRemoteLinkRetirement(staged, now());
        await retryRemoteCleanup();
      } else if (credential) {
        // Storage itself failed. Best effort only: no durable write can be promised then.
        try {
          await revokeRemoteLinkAuthorization(credential);
        } catch {
          /* Report failure below. */
        }
      }
      if (job.public.state === "pending")
        job.public = terminal(job.public, "failed", {
          errorCode: error instanceof LinkServiceError ? error.code : "authorization_failed",
        });
      if (error instanceof LinkServiceError) throw error;
      throw new LinkServiceError(422, "authorization_failed");
    }
  }
  async function authorization(
    context: LinkOperationContext,
    id: string,
  ): Promise<LinkAuthorization> {
    await authorize(context);
    pruneJobs();
    pruneRemoteJobs();
    pruneInteractive();
    const host = hostOAuthJobs.get(safeId(id));
    if (host) {
      if (host.context.ownerId !== context.ownerId) throw new LinkServiceError(404, "not_found");
      return structuredClone(host.public);
    }
    const interactive = interactiveJobs.get(safeId(id));
    if (interactive) {
      if (interactive.context.ownerId !== context.ownerId)
        throw new LinkServiceError(404, "not_found");
      if (interactive.public.state === "pending") await authorize(interactive.context);
      return structuredClone(interactive.public);
    }
    const remote = remoteJobs.get(safeId(id));
    if (remote) {
      if (remote.context.ownerId !== context.ownerId) throw new LinkServiceError(404, "not_found");
      return structuredClone(remote.public);
    }
    const job = jobs.get(safeId(id));
    if (!job || job.ownerId !== context.ownerId) throw new LinkServiceError(404, "not_found");
    return structuredClone(job.public);
  }
  async function cancelAuthorization(context: LinkOperationContext, id: string): Promise<void> {
    await authorize(context);
    safeId(id);
    const ownerId =
      hostOAuthJobs.get(id)?.context.ownerId ??
      remoteJobs.get(id)?.context.ownerId ??
      interactiveJobs.get(id)?.context.ownerId ??
      jobs.get(id)?.ownerId;
    if (!ownerId || ownerId !== context.ownerId) throw new LinkServiceError(404, "not_found");
    const host = hostOAuthJobs.get(id);
    if (host?.public.state === "pending") {
      host.cancel?.("cancelled");
    }
    const remote = remoteJobs.get(id);
    if (remote?.public.state === "pending") {
      remote.public = terminal(remote.public, "cancelled", { errorCode: "cancelled" });
      remote.retireAt = now() + 5 * 60_000;
    }
    const interactive = interactiveJobs.get(id);
    if (interactive) endInteractive(interactive, "cancelled");
    const job = jobs.get(id);
    if (job) cancelJob(job);
    await authorize(context);
  }
  function cancelOwner(ownerId: string): void {
    revokedOwners.add(ownerId);
    for (const [id, job] of hostOAuthJobs)
      if (job.context.ownerId === ownerId) {
        job.cancel?.("cancelled");
        job.operation.controller.abort();
        clearTimeout(job.timer);
        hostOAuthJobs.delete(id);
      }
    for (const [id, job] of interactiveJobs)
      if (job.context.ownerId === ownerId) {
        endInteractive(job, "cancelled");
        interactiveJobs.delete(id);
      }
    for (const [id, job] of remoteJobs) if (job.context.ownerId === ownerId) remoteJobs.delete(id);
    for (const operation of operations)
      if (operation.ownerId === ownerId) {
        operation.controller.abort();
        finish(operation);
      }
    for (const [id, job] of jobs)
      if (job.ownerId === ownerId) {
        cancelJob(job);
        jobs.delete(id);
      }
  }
  function close(): void {
    closed = true;
    clearInterval(cleanupTimer);
    clearTimeout(cleanupStartup);
    remoteJobs.clear();
    for (const job of hostOAuthJobs.values()) {
      job.cancel?.("cancelled");
      job.operation.controller.abort();
      clearTimeout(job.timer);
    }
    hostOAuthJobs.clear();
    for (const job of interactiveJobs.values()) endInteractive(job, "cancelled");
    interactiveJobs.clear();
    for (const operation of operations) operation.controller.abort();
    operations.clear();
    for (const job of jobs.values()) cancelJob(job);
    jobs.clear();
  }
  return {
    snapshot,
    persistValidatedConnection,
    assertAuthorized: authorize,
    connectToken,
    connectCli,
    cliStatus: getCliStatus,
    rename,
    disconnect,
    startDeviceAuth,
    startAuthorization,
    openHostAuthorization,
    respondAuthorization,
    refreshRemoteCatalog,
    startRemoteAuth,
    completeRemoteAuth,
    retryRemoteCleanup,
    authorization,
    cancelAuthorization,
    cancelOwner,
    close,
  };
}

export type LinkService = ReturnType<typeof createLinkService>;
