import { linkConnectionMetadata } from "@cjhyy/code-shell-link";
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credentialAllowsEnvExposure,
  credentialSecretHint,
  isCredentialSecretAvailable,
  type Credential,
  type CredentialType,
} from "./types.js";
import { CredentialStore } from "./store.js";
import { subscribeToLocalCredentialChanges } from "./change-subscription.js";
import {
  formatNetscapeCookies,
  parseCookieJar,
  summarizeCookieExpiry,
  type CookieExpirySummary,
} from "./cookie-jar.js";
import {
  parseOAuthCredentialSecret,
  isBrowserOAuthLinkCredential,
  resolveLinkCredentialAccessToken,
  shouldRefreshOAuthCredential,
  summarizeOAuthCredentialSecret,
} from "./oauth.js";
import {
  executeRemoteLinkAction,
  isRemoteLinkCredential,
  RemoteLinkError,
  type RemoteLinkActionRequest,
} from "../links/remote.js";
import {
  executeLocalOAuthLinkAction,
  type LocalOAuthLinkActionRequest,
} from "../links/local-oauth.js";
import { refreshToken } from "../services/oauth.js";
import { assertMcpOAuthCredentialBinding } from "./mcp-binding.js";
import type { SettingsScope } from "../settings/manager.js";
import type { RpcMessage, RpcResponse } from "../protocol/types.js";
import type { Transport } from "../protocol/transport.js";
import {
  isFigmaMcpCredential,
  McpLinkActionError,
  type McpLinkActionRequest,
} from "../links/figma-mcp-contract.js";

export type CredentialAccessScope = "full" | "project";

export interface CredentialMetadata {
  /** Opaque Host/store identity of the exact record approved for this process lifetime. */
  approvalIdentity?: string;
  id: string;
  type: CredentialType;
  label: string;
  autoUseByAI?: boolean;
  autoInjectByAI?: boolean;
  exposeAsEnv?: string;
  meta?: Credential["meta"];
  hasSecret: boolean;
  secretHint?: string;
  cookieExpiry?: CookieExpirySummary;
  oauthStatus?: import("./types.js").OAuthCredentialPublicStatus;
}

export interface CredentialAccess {
  executeMcpLinkAction?(
    request: McpLinkActionRequest,
    options?: { signal?: AbortSignal; assertAuthorized?: () => void },
  ): Promise<unknown>;
  executeLocalOAuthLinkAction?(
    request: LocalOAuthLinkActionRequest,
    options?: { signal?: AbortSignal; assertAuthorized?: () => void },
  ): Promise<unknown>;
  executeRemoteLinkAction?(
    request: RemoteLinkActionRequest,
    options?: { signal?: AbortSignal; assertAuthorized?: () => void },
  ): Promise<unknown>;
  listMasked(cwd: string | undefined, scope: CredentialAccessScope): CredentialMetadata[];
  /** Optional read diagnostics. False means the list may be incomplete, not that it is empty. */
  listMaskedWithStatus?(
    cwd: string | undefined,
    scope: CredentialAccessScope,
  ): { credentials: CredentialMetadata[]; readable: boolean };
  resolveMeta(
    cwd: string | undefined,
    id: string,
    scope: CredentialAccessScope,
  ): CredentialMetadata | undefined;
  envExposures(cwd: string | undefined, scope: CredentialAccessScope): Record<string, string>;
  /** Observe host snapshots or scoped local store changes to cancel in-flight Links. */
  subscribe?(
    listener: () => void,
    context?: { cwd?: string; scope: CredentialAccessScope },
  ): () => void;
  resolveValue?(req: {
    cwd?: string;
    id: string;
    scope: CredentialAccessScope;
    purpose: "use" | "mcp" | "link";
    expectedApprovalIdentity?: string;
  }): Promise<string>;
  /** Resolve only the bearer material needed by an MCP request. */
  resolveOAuthAccess?(req: {
    id: string;
    scope: "full";
    serverUrl: string;
    forceRefresh?: boolean;
  }): Promise<{ accessToken: string; expiresAt?: string }>;
  materializeCookie?(req: {
    cwd?: string;
    id: string;
    scope: CredentialAccessScope;
    expectedApprovalIdentity?: string;
  }): Promise<{ cookiesFile: string; count: number }>;
}

export interface CredentialSnapshotEntry {
  cwd?: string;
  full: CredentialMetadata[];
  project: CredentialMetadata[];
  /** Older hosts omit these; their credential-store readability is unknown. */
  readableFull?: boolean;
  readableProject?: boolean;
  envFull: Record<string, string>;
  envProject: Record<string, string>;
}

export interface CredentialSnapshot {
  revision: number;
  entries: CredentialSnapshotEntry[];
}

/** Host metadata and its Link Action outcome arrive as one ordered update. */
export interface RemoteLinkActionReply extends RpcResponse {
  credentialSnapshot?: CredentialSnapshot;
}

const COOKIE_FILE_PREFIX = "codeshell-cred-cookie-";
const COOKIE_FILE_MAX_AGE_MS = 30 * 60 * 1000;

let defaultCredentialAccess: CredentialAccess | null = null;

export function setDefaultCredentialAccess(access: CredentialAccess | null | undefined): void {
  defaultCredentialAccess = access ?? null;
}

export function getCredentialAccess(): CredentialAccess {
  return defaultCredentialAccess ?? localCredentialAccess;
}

export function createIpcCredentialAccess(
  transport: Pick<Transport, "send" | "onMessage">,
): CredentialAccess {
  let snapshot: CredentialSnapshot = { revision: 0, entries: [] };
  let nextId = 1;
  const subscribers = new Set<() => void>();
  const pending = new Map<
    string,
    {
      method: string;
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      cleanup?: () => void;
    }
  >();
  // The Host can still finish an already-sent Action after the calling task
  // cancels or times out. Keep only bounded, short-lived receipt IDs so that
  // its current status reaches other tasks without reviving the old request.
  const isStateAction = (method: string) =>
    ["desktop/remoteLinkAction", "desktop/localOAuthLinkAction", "desktop/mcpLinkAction"].includes(
      method,
    );
  const abandonedStateReplies = new Map<string, number>();
  const rememberAbandonedReply = (id: string, method: string) => {
    if (!isStateAction(method)) return;
    const now = Date.now();
    for (const [key, expiresAt] of abandonedStateReplies) {
      if (expiresAt <= now) abandonedStateReplies.delete(key);
    }
    if (abandonedStateReplies.size >= 128)
      abandonedStateReplies.delete(abandonedStateReplies.keys().next().value!);
    abandonedStateReplies.set(id, now + 60_000);
  };

  const applySnapshot = (value: unknown) => {
    const params = value as Partial<CredentialSnapshot> | undefined;
    // Delayed or replayed Host snapshots must not restore a superseded grant.
    if (
      params &&
      typeof params.revision === "number" &&
      Number.isSafeInteger(params.revision) &&
      params.revision > snapshot.revision &&
      Array.isArray(params.entries)
    ) {
      snapshot = {
        revision: params.revision,
        entries: params.entries as CredentialSnapshotEntry[],
      };
      for (const listener of subscribers) {
        try {
          listener();
        } catch {
          // One consumer must not break the credential snapshot transport.
        }
      }
    }
  };

  transport.onMessage((msg: RpcMessage) => {
    if ("method" in msg && msg.method === "desktop/credentialSnapshot") {
      applySnapshot(msg.params);
      return;
    }
    if (!("id" in msg) || "method" in msg) return;
    const id = String(msg.id);
    const waiter = pending.get(id);
    if (!waiter) {
      const expiresAt = abandonedStateReplies.get(id);
      abandonedStateReplies.delete(id);
      if (expiresAt !== undefined && expiresAt > Date.now())
        applySnapshot((msg as RemoteLinkActionReply).credentialSnapshot);
      return;
    }
    pending.delete(id);
    clearTimeout(waiter.timer);
    waiter.cleanup?.();
    // Snapshot subscribers may abort other Actions when authority changes. This
    // reply's waiter is already retired so its reviewed error cannot be replaced
    // by that derived cancellation. Successful results still recheck authority.
    if (isStateAction(waiter.method))
      applySnapshot((msg as RemoteLinkActionReply).credentialSnapshot);
    if ("error" in msg && msg.error) {
      const data = msg.error.data as
        | { remoteLinkCode?: unknown; mcpLinkCode?: unknown }
        | undefined;
      const remoteLinkCode =
        waiter.method === "desktop/remoteLinkAction" ? data?.remoteLinkCode : undefined;
      const mcpLinkCode = waiter.method === "desktop/mcpLinkAction" ? data?.mcpLinkCode : undefined;
      waiter.reject(
        typeof mcpLinkCode === "string" &&
          [
            "invalid_request",
            "changed",
            "forbidden",
            "reconnect",
            "unsupported",
            "response_too_large",
            "resource_not_discovered",
            "provider_error",
          ].includes(mcpLinkCode)
          ? new McpLinkActionError(
              mcpLinkCode as ConstructorParameters<typeof McpLinkActionError>[0],
            )
          : typeof remoteLinkCode === "string" &&
              [
                "invalid_request",
                "unavailable",
                "configuration_error",
                "refresh_outcome_unknown",
                "reconnect",
                "changed",
                "forbidden",
                "file_not_authorized",
                "unsupported_file_type",
                "response_too_large",
                "content_unavailable",
                "busy",
              ].includes(remoteLinkCode)
            ? new RemoteLinkError(
                remoteLinkCode as ConstructorParameters<typeof RemoteLinkError>[0],
              )
            : new Error(msg.error.message),
      );
    } else {
      waiter.resolve(msg.result);
    }
  });

  const request = (
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    signal?.throwIfAborted();
    const id = `cred-${nextId++}`;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        if (!pending.has(id)) return;
        pending.delete(id);
        rememberAbandonedReply(id, method);
        clearTimeout(timer);
        cleanup();
        transport.send({
          jsonrpc: "2.0",
          method: "desktop/localOAuthLinkActionCancel",
          params: { requestId: id },
        });
        reject(new DOMException("Local Link action cancelled", "AbortError"));
      };
      const cleanup = () => signal?.removeEventListener("abort", cancel);
      const timer = setTimeout(
        () => {
          if (!pending.has(id)) return;
          pending.delete(id);
          rememberAbandonedReply(id, method);
          cleanup();
          if (method === "desktop/localOAuthLinkAction" || method === "desktop/mcpLinkAction")
            transport.send({
              jsonrpc: "2.0",
              method: "desktop/localOAuthLinkActionCancel",
              params: { requestId: id },
            });
          reject(new Error(`${method} timed out`));
        },
        method === "desktop/localOAuthLinkAction" || method === "desktop/mcpLinkAction"
          ? 90_000
          : method === "desktop/remoteLinkAction"
            ? 45_000
            : 30_000,
      );
      pending.set(id, { method, resolve, reject, timer, cleanup });
      signal?.addEventListener("abort", cancel, { once: true });
      transport.send({ jsonrpc: "2.0", id, method, params });
    });
  };

  const entryFor = (cwd: string | undefined): CredentialSnapshotEntry | undefined => {
    const key = cwd ?? "";
    return snapshot.entries.find((entry) => (entry.cwd ?? "") === key);
  };

  return {
    executeMcpLinkAction: async (input, options) => {
      options?.signal?.throwIfAborted();
      options?.assertAuthorized?.();
      const result = await request(
        "desktop/mcpLinkAction",
        input as unknown as Record<string, unknown>,
        options?.signal,
      );
      options?.signal?.throwIfAborted();
      options?.assertAuthorized?.();
      return result;
    },
    executeLocalOAuthLinkAction: async (input, options) => {
      options?.signal?.throwIfAborted();
      options?.assertAuthorized?.();
      const result = await request(
        "desktop/localOAuthLinkAction",
        input as unknown as Record<string, unknown>,
        options?.signal,
      );
      options?.signal?.throwIfAborted();
      options?.assertAuthorized?.();
      return result;
    },
    executeRemoteLinkAction: async (input, options) => {
      options?.signal?.throwIfAborted();
      options?.assertAuthorized?.();
      const result = await request(
        "desktop/remoteLinkAction",
        input as unknown as Record<string, unknown>,
        options?.signal,
      );
      options?.signal?.throwIfAborted();
      options?.assertAuthorized?.();
      return result;
    },
    listMasked(cwd, scope) {
      const entry = entryFor(cwd);
      if (!entry) return [];
      return scope === "project" ? cloneMetadata(entry.project) : cloneMetadata(entry.full);
    },
    listMaskedWithStatus(cwd, scope) {
      const entry = entryFor(cwd);
      if (!entry) return { credentials: [], readable: false };
      return {
        credentials: cloneMetadata(scope === "project" ? entry.project : entry.full),
        readable: (scope === "project" ? entry.readableProject : entry.readableFull) === true,
      };
    },
    resolveMeta(cwd, id, scope) {
      const entry = entryFor(cwd);
      if (!entry) return undefined;
      const list = scope === "project" ? entry.project : entry.full;
      return cloneMetadata(list).find((cred) => cred.id === id);
    },
    envExposures(cwd, scope) {
      const entry = entryFor(cwd);
      if (!entry) return {};
      return { ...(scope === "project" ? entry.envProject : entry.envFull) };
    },
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    async resolveValue(req) {
      const result = (await request(
        "desktop/credentialResolve",
        req as unknown as Record<string, unknown>,
      )) as {
        value?: unknown;
      };
      if (typeof result?.value !== "string")
        throw new Error(`credential "${req.id}" is unavailable`);
      return result.value;
    },
    async resolveOAuthAccess(req) {
      const result = (await request(
        "desktop/oauthAccessResolve",
        req as unknown as Record<string, unknown>,
      )) as { accessToken?: unknown; expiresAt?: unknown };
      if (typeof result?.accessToken !== "string") {
        throw new Error(`oauth credential "${req.id}" requires login`);
      }
      return {
        accessToken: result.accessToken,
        expiresAt: typeof result.expiresAt === "string" ? result.expiresAt : undefined,
      };
    },
    async materializeCookie(req) {
      const result = (await request(
        "desktop/credentialMaterializeCookie",
        req as unknown as Record<string, unknown>,
      )) as {
        cookiesFile?: unknown;
        count?: unknown;
      };
      if (typeof result?.cookiesFile !== "string" || typeof result.count !== "number") {
        throw new Error(`cookie credential "${req.id}" is unavailable`);
      }
      return { cookiesFile: result.cookiesFile, count: result.count };
    },
  };
}

export function credentialAccessScope(scope: SettingsScope | undefined): CredentialAccessScope {
  return scope === "full" || scope === undefined ? "full" : "project";
}

export { isCredentialSecretAvailable } from "./types.js";

function toMetadata(cred: Credential, approvalIdentity: string): CredentialMetadata {
  const secret = cred.secret;
  const available = isCredentialSecretAvailable(secret);
  const { secret: _secret, ...rest } = cred;
  return {
    ...rest,
    approvalIdentity,
    meta: cred.meta ? linkConnectionMetadata(cred.meta) : undefined,
    ...(credentialAllowsEnvExposure(cred.type) ? {} : { exposeAsEnv: undefined }),
    hasSecret: available,
    secretHint: available ? credentialSecretHint(cred.type, secret) : undefined,
    ...(cred.type === "oauth" || isBrowserOAuthLinkCredential(cred)
      ? { oauthStatus: summarizeOAuthCredentialSecret(secret) }
      : {}),
    ...(cred.type === "cookie" ? { cookieExpiry: summarizeCookieExpiry(secret) } : {}),
  };
}

function cloneMetadata(list: CredentialMetadata[]): CredentialMetadata[] {
  return list.map((cred) => ({
    ...cred,
    meta: cred.meta ? linkConnectionMetadata(cred.meta) : undefined,
  }));
}

function storeFor(cwd: string | undefined): CredentialStore {
  return new CredentialStore(cwd);
}

export const localCredentialAccess: CredentialAccess = {
  executeMcpLinkAction: async (input, options) => {
    // Metadata discovery also runs while the builtin catalog is initializing.
    // Load the MCP/tool execution graph only for an actual action request.
    const { executeFigmaMcpLinkAction } = await import("../links/figma-mcp.js");
    return executeFigmaMcpLinkAction(input, {
      ...options,
      resolveOAuthAccess: (request) => localCredentialAccess.resolveOAuthAccess!(request),
    });
  },
  executeLocalOAuthLinkAction,
  executeRemoteLinkAction,
  subscribe(listener, context) {
    return subscribeToLocalCredentialChanges(listener, context);
  },
  listMasked(cwd, scope) {
    return localCredentialAccess.listMaskedWithStatus!(cwd, scope).credentials;
  },
  listMaskedWithStatus(cwd, scope) {
    const store = storeFor(cwd);
    const result = store.listWithSources(scope);
    return {
      credentials: result.credentials.map(({ credential, source }) =>
        toMetadata(credential, store.approvalIdentity(source, credential)),
      ),
      readable: result.readable,
    };
  },
  resolveMeta(cwd, id, scope) {
    const record = storeFor(cwd).resolveForApproval(id, scope);
    return record ? toMetadata(record.credential, record.approvalIdentity) : undefined;
  },
  envExposures(cwd, scope) {
    const out: Record<string, string> = {};
    const creds = storeFor(cwd).list(scope);
    for (const cred of creds) {
      if (!credentialAllowsEnvExposure(cred.type)) continue;
      const name = cred.exposeAsEnv?.trim();
      if (name && isCredentialSecretAvailable(cred.secret)) out[name] = cred.secret;
    }
    return out;
  },
  async resolveValue(req) {
    const record = storeFor(req.cwd).resolveForApproval(req.id, req.scope);
    if (req.expectedApprovalIdentity && record?.approvalIdentity !== req.expectedApprovalIdentity)
      throw new Error("credential changed after approval");
    const cred = record?.credential;
    if (!cred || !isCredentialSecretAvailable(cred.secret)) {
      throw new Error(`credential "${req.id}" is unavailable`);
    }
    if (
      isRemoteLinkCredential(cred) ||
      isBrowserOAuthLinkCredential(cred) ||
      isFigmaMcpCredential(cred) ||
      (req.purpose !== "link" && cred.meta?.agentExposable === false)
    )
      throw new Error("OAuth Link credentials only support Host-owned actions");
    if (
      req.purpose === "link" &&
      (cred.type !== "link" ||
        linkConnectionMetadata(cred.meta).linkExecutionRuntime !== "local" ||
        !cred.meta?.linkProvider)
    ) {
      throw new Error(`credential "${req.id}" is not a local Link credential`);
    }
    return req.purpose === "link" ? resolveLinkCredentialAccessToken(cred)! : cred.secret;
  },
  async resolveOAuthAccess(req) {
    return resolveLocalOAuthAccess(req.id, req.serverUrl, Boolean(req.forceRefresh));
  },
  async materializeCookie(req) {
    const record = storeFor(req.cwd).resolveForApproval(req.id, req.scope);
    if (req.expectedApprovalIdentity && record?.approvalIdentity !== req.expectedApprovalIdentity)
      throw new Error("credential changed after approval");
    const cred = record?.credential;
    if (!cred || cred.type !== "cookie" || !isCredentialSecretAvailable(cred.secret)) {
      throw new Error(`cookie credential "${req.id}" is unavailable`);
    }
    return materializeCookieSecret(cred.id, cred.secret);
  },
};

const localOAuthRefreshes = new Map<string, Promise<{ accessToken: string; expiresAt?: string }>>();

async function resolveLocalOAuthAccess(
  id: string,
  serverUrl: string,
  forceRefresh: boolean,
): Promise<{ accessToken: string; expiresAt?: string }> {
  const store = new CredentialStore(undefined);
  const cred = store.resolve(id, "full");
  if (!cred || cred.type !== "oauth" || !isCredentialSecretAvailable(cred.secret)) {
    throw new Error(`oauth credential "${id}" requires login`);
  }
  if (isRemoteLinkCredential(cred))
    throw new Error("Remote Link credentials cannot be used as MCP bearer tokens");
  const parsed = parseOAuthCredentialSecret(cred.secret);
  assertMcpOAuthCredentialBinding(cred, serverUrl, parsed);
  const decision = shouldRefreshOAuthCredential(parsed);
  if (!forceRefresh && decision === "no") {
    return { accessToken: parsed.accessToken, expiresAt: parsed.expiresAt };
  }
  if (!parsed.refreshToken || !parsed.tokenEndpoint || !parsed.clientId) {
    throw new Error(`oauth credential "${id}" requires login`);
  }
  const inflight = localOAuthRefreshes.get(id);
  if (inflight) {
    const result = await inflight;
    const current = store.resolve(id, "full");
    if (!current?.secret) throw new Error("MCP OAuth credential is unavailable");
    assertMcpOAuthCredentialBinding(current, serverUrl, parseOAuthCredentialSecret(current.secret));
    return result;
  }
  const pending = (async () => {
    const latestCred = store.resolve(id, "full");
    if (!latestCred || latestCred.type !== "oauth" || !latestCred.secret) {
      throw new Error(`oauth credential "${id}" requires login`);
    }
    const latest = parseOAuthCredentialSecret(latestCred.secret);
    assertMcpOAuthCredentialBinding(latestCred, serverUrl, latest);
    if (!forceRefresh && shouldRefreshOAuthCredential(latest) === "no") {
      return { accessToken: latest.accessToken, expiresAt: latest.expiresAt };
    }
    if (!latest.refreshToken || !latest.tokenEndpoint || !latest.clientId) {
      throw new Error(`oauth credential "${id}" requires login`);
    }
    const tokens = await refreshToken(
      {
        clientId: latest.clientId,
        clientSecret: latest.clientSecret,
        tokenEndpoint: latest.tokenEndpoint,
        authorizationEndpoint: "",
        scopes: latest.scopes,
        resource: latest.resource,
      },
      latest.refreshToken,
    );
    const next = {
      ...latest,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? latest.refreshToken,
      expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : undefined,
      tokenType: tokens.tokenType,
      scope: tokens.scope ?? latest.scope,
    };
    assertMcpOAuthCredentialBinding(latestCred, serverUrl, next);
    if (
      !store.compareAndSwap("user", id, latestCred, {
        ...latestCred,
        secret: JSON.stringify(next),
        meta: { ...latestCred.meta, lastRefreshAt: new Date().toISOString() },
      })
    )
      throw new Error("MCP OAuth credential changed during refresh");
    return { accessToken: next.accessToken, expiresAt: next.expiresAt };
  })().finally(() => localOAuthRefreshes.delete(id));
  localOAuthRefreshes.set(id, pending);
  return pending;
}

export function materializeCookieSecret(
  credentialId: string,
  secret: string,
): { cookiesFile: string; count: number } {
  const jar = parseCookieJar(secret);
  if (jar.length === 0) throw new Error("cookie jar is empty or invalid");
  const file = join(
    tmpdir(),
    `${COOKIE_FILE_PREFIX}${safeFileName(credentialId)}-${process.pid}-${randomUUID()}.txt`,
  );
  writeFileSync(file, formatNetscapeCookies(jar), { mode: 0o600 });
  return { cookiesFile: file, count: jar.length };
}

export function sweepStaleCredentialCookieFiles(now = Date.now()): void {
  const dir = tmpdir();
  try {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(COOKIE_FILE_PREFIX)) continue;
      const p = join(dir, f);
      try {
        if (now - statSync(p).mtimeMs > COOKIE_FILE_MAX_AGE_MS) rmSync(p, { force: true });
      } catch {
        /* skip */
      }
    }
  } catch {
    /* best-effort */
  }
}

function safeFileName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
