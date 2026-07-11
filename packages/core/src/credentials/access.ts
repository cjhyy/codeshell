import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credentialAllowsEnvExposure,
  credentialSecretHint,
  type Credential,
  type CredentialType,
} from "./types.js";
import { CredentialStore } from "./store.js";
import { formatNetscapeCookies, parseCookieJar } from "./cookie-jar.js";
import {
  parseOAuthCredentialSecret,
  shouldRefreshOAuthCredential,
  summarizeOAuthCredentialSecret,
} from "./oauth.js";
import { refreshToken } from "../services/oauth.js";
import type { SettingsScope } from "../settings/manager.js";
import type { RpcMessage } from "../protocol/types.js";
import type { Transport } from "../protocol/transport.js";

export type CredentialAccessScope = "full" | "project";

export interface CredentialMetadata {
  id: string;
  type: CredentialType;
  label: string;
  autoUseByAI?: boolean;
  autoInjectByAI?: boolean;
  exposeAsEnv?: string;
  meta?: Credential["meta"];
  hasSecret: boolean;
  secretHint?: string;
  oauthStatus?: import("./types.js").OAuthCredentialPublicStatus;
}

export interface CredentialAccess {
  listMasked(cwd: string | undefined, scope: CredentialAccessScope): CredentialMetadata[];
  resolveMeta(
    cwd: string | undefined,
    id: string,
    scope: CredentialAccessScope,
  ): CredentialMetadata | undefined;
  envExposures(cwd: string | undefined, scope: CredentialAccessScope): Record<string, string>;
  resolveValue?(req: {
    cwd?: string;
    id: string;
    scope: CredentialAccessScope;
    purpose: "use" | "mcp";
  }): Promise<string>;
  /** Resolve only the bearer material needed by an MCP request. */
  resolveOAuthAccess?(req: {
    id: string;
    scope: "full";
    forceRefresh?: boolean;
  }): Promise<{ accessToken: string; expiresAt?: string }>;
  materializeCookie?(req: {
    cwd?: string;
    id: string;
    scope: CredentialAccessScope;
  }): Promise<{ cookiesFile: string; count: number }>;
}

export interface CredentialSnapshotEntry {
  cwd?: string;
  full: CredentialMetadata[];
  project: CredentialMetadata[];
  envFull: Record<string, string>;
  envProject: Record<string, string>;
}

export interface CredentialSnapshot {
  revision: number;
  entries: CredentialSnapshotEntry[];
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
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  transport.onMessage((msg: RpcMessage) => {
    if ("method" in msg && msg.method === "desktop/credentialSnapshot") {
      const params = msg.params as Partial<CredentialSnapshot> | undefined;
      if (params && typeof params.revision === "number" && Array.isArray(params.entries)) {
        snapshot = {
          revision: params.revision,
          entries: params.entries as CredentialSnapshotEntry[],
        };
      }
      return;
    }
    if (!("id" in msg) || "method" in msg) return;
    const id = String(msg.id);
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    clearTimeout(waiter.timer);
    if ("error" in msg && msg.error) {
      waiter.reject(new Error(msg.error.message));
    } else {
      waiter.resolve(msg.result);
    }
  });

  const request = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const id = `cred-${nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 30_000);
      pending.set(id, { resolve, reject, timer });
      transport.send({ jsonrpc: "2.0", id, method, params });
    });
  };

  const entryFor = (cwd: string | undefined): CredentialSnapshotEntry | undefined => {
    const key = cwd ?? "";
    return snapshot.entries.find((entry) => (entry.cwd ?? "") === key);
  };

  return {
    listMasked(cwd, scope) {
      const entry = entryFor(cwd);
      if (!entry) return [];
      return scope === "project" ? cloneMetadata(entry.project) : cloneMetadata(entry.full);
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

export function isCredentialSecretAvailable(secret: string | undefined): secret is string {
  return typeof secret === "string" && secret.length > 0 && !secret.startsWith("enc:");
}

function toMetadata(cred: Credential): CredentialMetadata {
  const secret = cred.secret;
  const available = isCredentialSecretAvailable(secret);
  const { secret: _secret, ...rest } = cred;
  return {
    ...rest,
    ...(credentialAllowsEnvExposure(cred.type) ? {} : { exposeAsEnv: undefined }),
    hasSecret: available,
    secretHint: available ? credentialSecretHint(cred.type, secret) : undefined,
    ...(cred.type === "oauth" ? { oauthStatus: summarizeOAuthCredentialSecret(secret) } : {}),
  };
}

function cloneMetadata(list: CredentialMetadata[]): CredentialMetadata[] {
  return list.map((cred) => ({ ...cred, meta: cred.meta ? { ...cred.meta } : undefined }));
}

function storeFor(cwd: string | undefined): CredentialStore {
  return new CredentialStore(cwd);
}

export const localCredentialAccess: CredentialAccess = {
  listMasked(cwd, scope) {
    return storeFor(cwd).list(scope).map(toMetadata);
  },
  resolveMeta(cwd, id, scope) {
    const cred = storeFor(cwd).resolve(id, scope);
    return cred ? toMetadata(cred) : undefined;
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
    const cred = storeFor(req.cwd).resolve(req.id, req.scope);
    if (!cred || !isCredentialSecretAvailable(cred.secret)) {
      throw new Error(`credential "${req.id}" is unavailable`);
    }
    return cred.secret;
  },
  async resolveOAuthAccess(req) {
    return resolveLocalOAuthAccess(req.id, Boolean(req.forceRefresh));
  },
  async materializeCookie(req) {
    const cred = storeFor(req.cwd).resolve(req.id, req.scope);
    if (!cred || cred.type !== "cookie" || !isCredentialSecretAvailable(cred.secret)) {
      throw new Error(`cookie credential "${req.id}" is unavailable`);
    }
    return materializeCookieSecret(cred.id, cred.secret);
  },
};

const localOAuthRefreshes = new Map<string, Promise<{ accessToken: string; expiresAt?: string }>>();

async function resolveLocalOAuthAccess(
  id: string,
  forceRefresh: boolean,
): Promise<{ accessToken: string; expiresAt?: string }> {
  const store = new CredentialStore(undefined);
  const cred = store.resolve(id, "full");
  if (!cred || cred.type !== "oauth" || !isCredentialSecretAvailable(cred.secret)) {
    throw new Error(`oauth credential "${id}" requires login`);
  }
  const parsed = parseOAuthCredentialSecret(cred.secret);
  const decision = shouldRefreshOAuthCredential(parsed);
  if (!forceRefresh && decision === "no") {
    return { accessToken: parsed.accessToken, expiresAt: parsed.expiresAt };
  }
  if (!parsed.refreshToken || !parsed.tokenEndpoint || !parsed.clientId) {
    throw new Error(`oauth credential "${id}" requires login`);
  }
  const inflight = localOAuthRefreshes.get(id);
  if (inflight) return inflight;
  const pending = (async () => {
    const latestCred = store.resolve(id, "full");
    if (!latestCred || latestCred.type !== "oauth" || !latestCred.secret) {
      throw new Error(`oauth credential "${id}" requires login`);
    }
    const latest = parseOAuthCredentialSecret(latestCred.secret);
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
    store.save("user", {
      ...latestCred,
      secret: JSON.stringify(next),
      meta: { ...latestCred.meta, lastRefreshAt: new Date().toISOString() },
    });
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
