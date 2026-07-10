import {
  CredentialStore,
  credentialAllowsEnvExposure,
  isCredentialSecretAvailable,
  materializeCookieSecret,
  summarizeOAuthCredentialSecret,
  type CredentialAccessScope,
  type Credential,
  type CredentialMetadata,
  type CredentialSnapshot,
  type CredentialSnapshotEntry,
} from "@cjhyy/code-shell-core";

export interface CredentialResolveRequest {
  cwd?: string;
  id: string;
  scope: CredentialAccessScope;
  purpose: "use" | "mcp";
}

export interface CredentialMaterializeCookieRequest {
  cwd?: string;
  id: string;
  scope: CredentialAccessScope;
}

export function buildCredentialSnapshot(
  cwds: Array<string | undefined>,
  revision: number,
): CredentialSnapshot {
  const entries: CredentialSnapshotEntry[] = [];
  const seen = new Set<string>();
  for (const cwd of [undefined, ...cwds]) {
    const key = cwd ?? "";
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(buildCredentialSnapshotEntry(cwd));
  }
  return { revision, entries };
}

export function resolveCredentialValueForWorker(req: CredentialResolveRequest): { value: string } {
  const cred = new CredentialStore(req.cwd).resolve(req.id, req.scope);
  if (!cred || !isCredentialSecretAvailable(cred.secret)) {
    throw new Error(`credential "${req.id}" is unavailable`);
  }
  const allowed =
    req.purpose === "mcp"
      ? cred.type === "token" || cred.type === "link"
      : cred.type === "token" || cred.type === "link";
  if (!allowed) {
    throw new Error(
      `credential "${req.id}" is not a ${
        req.purpose === "mcp" ? "token/link (OAuth uses the host access resolver)" : "token/link"
      } credential`,
    );
  }
  return { value: cred.secret };
}

export function materializeCredentialCookieForWorker(req: CredentialMaterializeCookieRequest): {
  cookiesFile: string;
  count: number;
} {
  const cred = new CredentialStore(req.cwd).resolve(req.id, req.scope);
  if (!cred || cred.type !== "cookie" || !isCredentialSecretAvailable(cred.secret)) {
    throw new Error(`cookie credential "${req.id}" is unavailable`);
  }
  return materializeCookieSecret(cred.id, cred.secret);
}

function buildCredentialSnapshotEntry(cwd: string | undefined): CredentialSnapshotEntry {
  const store = new CredentialStore(cwd);
  return {
    cwd,
    full: store.list("full").map(toMetadata),
    project: store.list("project").map(toMetadata),
    envFull: envExposures(store, "full"),
    envProject: envExposures(store, "project"),
  };
}

function envExposures(
  store: CredentialStore,
  scope: CredentialAccessScope,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const cred of store.list(scope)) {
    if (!credentialAllowsEnvExposure(cred.type)) continue;
    const name = cred.exposeAsEnv?.trim();
    if (name && isCredentialSecretAvailable(cred.secret)) {
      out[name] = cred.secret;
    }
  }
  return out;
}

function toMetadata(cred: Credential): CredentialMetadata {
  const { id, type, label, autoUseByAI, autoInjectByAI, meta } = cred;
  const secret = cred.secret;
  const hasSecret = isCredentialSecretAvailable(secret);
  return {
    id,
    type,
    label,
    autoUseByAI,
    autoInjectByAI,
    exposeAsEnv: credentialAllowsEnvExposure(type) ? cred.exposeAsEnv : undefined,
    meta,
    hasSecret,
    secretHint: hasSecret ? (secret.length > 4 ? `****${secret.slice(-4)}` : "****") : undefined,
    ...(cred.type === "oauth" ? { oauthStatus: summarizeOAuthCredentialSecret(secret) } : {}),
  };
}
