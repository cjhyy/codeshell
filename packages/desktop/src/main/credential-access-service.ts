import {
  CredentialStore,
  credentialAllowsEnvExposure,
  credentialSecretHint,
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
  purpose: "use" | "mcp" | "link";
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
  if (req.purpose !== "link" && cred.meta?.agentExposable === false) {
    // Trust boundary lives here in the main process, not in the worker: a
    // credential marked agentExposable:false may only feed Link Action
    // execution and must never surface its raw token to agent-facing purposes.
    throw new Error(
      `credential "${req.id}" is restricted to Link Actions and never returns its raw token`,
    );
  }
  const allowed =
    req.purpose === "link"
      ? cred.type === "link" &&
        cred.meta?.linkExecutionRuntime === "local" &&
        Boolean(cred.meta.linkProvider)
      : cred.type === "token" || cred.type === "link";
  if (!allowed) {
    throw new Error(
      `credential "${req.id}" is not a ${
        req.purpose === "mcp"
          ? "token/link (OAuth uses the host access resolver)"
          : req.purpose === "link"
            ? "local Link"
            : "token/link"
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
    secretHint: hasSecret ? credentialSecretHint(type, secret) : undefined,
    ...(cred.type === "oauth" ? { oauthStatus: summarizeOAuthCredentialSecret(secret) } : {}),
  };
}
