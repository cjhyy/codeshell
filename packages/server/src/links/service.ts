import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  CredentialStore,
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
  LinkDeviceOAuthBroker,
  isLocalBrowserLinkProvider,
  type LocalBrowserAuthPrompt,
  type LocalBrowserAuthToken,
} from "./device-oauth.js";
import type {
  LinkAuthorization,
  LinkConnectionInput,
  LinkErrorCode,
  LinkOperationContext,
  LinkSnapshot,
  MaskedLinkConnection,
  TokenConnectionInput,
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
  /** Test seams. Production delegates to Core's fixed provider and CLI executors. */
  validateToken?: typeof validateLocalLinkToken;
  cliStatus?: typeof getCliLinkStatus;
  bindCli?: typeof connectCliLink;
  createDeviceBroker?: () => LinkDeviceOAuthBroker;
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
  const revokedOwners = new Set<string>();
  let closed = false;
  let snapshotSignature = "";
  let snapshotRevision = randomUUID();

  function unavailable(context: LinkOperationContext): void {
    if (closed) throw new LinkServiceError(503, "unavailable");
    if (!context.ownerId || revokedOwners.has(context.ownerId))
      throw new LinkServiceError(401, "login_required");
  }
  async function authorize(context: LinkOperationContext): Promise<void> {
    unavailable(context);
    if (!(await context.authorize())) throw new LinkServiceError(401, "login_required");
    unavailable(context);
  }
  function begin(context: LinkOperationContext): ActiveOperation {
    unavailable(context);
    if (
      operations.size >= 8 ||
      [...operations].filter((operation) => operation.ownerId === context.ownerId).length >= 2
    )
      throw new LinkServiceError(409, "busy");
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
    const current = store.listWithStatus("full");
    if (!current.readable) throw new LinkServiceError(503, "unavailable");
    return {
      credentials: current.credentials,
      projectIds: new Set(store.list("project").map((c) => c.id)),
    };
  }
  function isLink(credential: Credential): boolean {
    return (
      credential.type === "link" &&
      credential.meta?.linkExecutionRuntime === "local" &&
      providers.some((provider) => provider.id === credential.meta?.linkProvider)
    );
  }
  function masked(credential: Credential, scope: "user" | "project"): MaskedLinkConnection {
    const meta = credential.meta!;
    const oauth =
      meta.linkAuthSource === "browser-oauth"
        ? summarizeOAuthCredentialSecret(credential.secret)
        : undefined;
    const status = !isCredentialSecretAvailable(credential.secret)
      ? "unavailable"
      : oauth?.state === "expired"
        ? "expired"
        : oauth?.state === "invalid" || oauth?.state === "missing"
          ? "invalid"
          : "connected";
    return {
      id: credential.id,
      providerId: meta.linkProvider!,
      methodId: meta.linkConnectionMethod ?? "",
      label: credential.label,
      runtime: "local",
      authSource:
        meta.linkExecutionBackend === "cli"
          ? "cli-session"
          : meta.linkAuthSource === "browser-oauth"
            ? "browser-oauth"
            : "manual-token",
      status,
      scope,
      editable: scope === "user",
      revision: revision(credential),
      account: {
        id: meta.linkAccountId,
        label: meta.linkAccountLabel,
        resources: meta.linkResourceLabels?.slice(0, 100) ?? [],
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
    const result = {
      providers: providers.map((provider) => ({
        ...provider,
        ...(isLocalBrowserLinkProvider(provider.id)
          ? { deviceAuth: createBroker().status(provider.id) }
          : {}),
      })),
      connections: current.credentials
        .filter(isLink)
        .map((credential) =>
          masked(credential, current.projectIds.has(credential.id) ? "project" : "user"),
        ),
      capabilities: { token: true, cliBinding: true, deviceAuth: true },
    };
    const signature = JSON.stringify(result);
    if (signature !== snapshotSignature) {
      snapshotSignature = signature;
      snapshotRevision = randomUUID();
    }
    return { ...result, revision: snapshotRevision };
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
    const current = records();
    const credential = current.credentials.find((entry) => entry.id === id);
    if (!credential || !isLink(credential)) throw new LinkServiceError(409, "conflict");
    if (current.projectIds.has(id)) throw new LinkServiceError(403, "read_only");
    if (revision(credential) !== string(expectedRevision, 64))
      throw new LinkServiceError(409, "conflict");
    return credential;
  }
  function prepare(raw: LinkConnectionInput): PreparedConnection {
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
    const id = input.connectionId ?? `link-${input.providerId}-${input.methodId}`;
    let expected: Credential | null = null;
    if (input.expectedRevision === null) {
      if (records().credentials.some((credential) => credential.id === id))
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
  function swap(prepared: PreparedConnection, next: Credential | null): void {
    const current = records();
    if (current.projectIds.has(prepared.id)) throw new LinkServiceError(403, "read_only");
    if (!store.compareAndSwap("user", prepared.id, prepared.expected, next))
      throw new LinkServiceError(409, "conflict");
  }
  async function commit(
    context: LinkOperationContext,
    prepared: PreparedConnection,
    validation: LocalLinkValidationResult,
    secret: string,
    authSource: MaskedLinkConnection["authSource"],
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
        linkExecutionRuntime: "local",
        linkAuthSource: authSource,
        linkExecutionBackend: authSource === "cli-session" ? "cli" : "http-token",
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
      swap(prepared, credential);
      return masked(credential, "user");
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
    // Revocation must work during an active action; the host's credential observer aborts it.
    await change(
      context,
      () =>
        swap({ id: credential.id, expected: credential, input: {} as LinkConnectionInput }, null),
      true,
    );
  }
  function cancelJob(job: AuthorizationJob): void {
    job.operation.controller.abort();
    if (job.brokerAttempt) job.broker.cancel(job.brokerAttempt);
    if (job.timer) clearTimeout(job.timer);
    if (job.public.state === "pending")
      job.public = {
        id: job.public.id,
        providerId: job.public.providerId,
        state: "cancelled",
        errorCode: "cancelled",
      };
    finish(job.operation);
    job.expiresAt = now() + 5 * 60_000;
  }
  function expireJob(job: AuthorizationJob): void {
    if (job.public.state !== "pending") return;
    cancelJob(job);
    job.public = {
      id: job.public.id,
      providerId: job.public.providerId,
      state: "failed",
      errorCode: "authorization_expired",
    };
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
    try {
      const token = await job.broker.complete(job.brokerAttempt!);
      await authorize(job.context);
      if (job.operation.controller.signal.aborted || job.public.state !== "pending")
        throw new LinkServiceError(409, "cancelled");
      if (token.providerId !== prepared.input.providerId)
        throw new LinkServiceError(422, "authorization_failed");
      const validation = await validateToken(token.providerId, token.accessToken, {
        signal: job.operation.controller.signal,
      });
      await authorize(job.context);
      if (job.operation.controller.signal.aborted || job.public.state !== "pending")
        throw new LinkServiceError(409, "cancelled");
      const connection = await commit(
        {
          ...job.context,
          authorize: async () =>
            (await job.context.authorize()) &&
            !job.operation.controller.signal.aborted &&
            job.public.state === "pending",
        },
        prepared,
        validation,
        tokenSecret(token),
        "browser-oauth",
      );
      if (job.public.state === "pending")
        job.public = {
          id: job.public.id,
          providerId: job.public.providerId,
          state: "connected",
          connection,
        };
    } catch (error) {
      if (job.public.state === "pending")
        job.public = {
          id: job.public.id,
          providerId: job.public.providerId,
          state: "failed",
          errorCode: error instanceof LinkServiceError ? error.code : "authorization_failed",
        };
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
    pruneJobs();
    if (jobs.size >= 32) throw new LinkServiceError(409, "busy");
    const operation = begin(context);
    let job: AuthorizationJob | undefined;
    try {
      await authorize(context);
      const prepared = prepare(input);
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
        public: { id, providerId, state: "pending" },
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
  async function authorization(
    context: LinkOperationContext,
    id: string,
  ): Promise<LinkAuthorization> {
    await authorize(context);
    pruneJobs();
    const job = jobs.get(safeId(id));
    if (!job || job.ownerId !== context.ownerId) throw new LinkServiceError(404, "not_found");
    return structuredClone(job.public);
  }
  async function cancelAuthorization(context: LinkOperationContext, id: string): Promise<void> {
    await authorization(context, id);
    const job = jobs.get(id);
    if (job) cancelJob(job);
    await authorize(context);
  }
  function cancelOwner(ownerId: string): void {
    revokedOwners.add(ownerId);
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
    authorization,
    cancelAuthorization,
    cancelOwner,
    close,
  };
}

export type LinkService = ReturnType<typeof createLinkService>;
