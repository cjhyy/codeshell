import type { Credential } from "../credentials/types.js";
import { CredentialStore, type CredentialScope } from "../credentials/store.js";
import { OperationLedger } from "../operations/ledger.js";
import { isRemoteLinkCredential } from "./remote.js";
import { GITHUB_OPERATION_CONFLICT_SCOPE } from "./operation-recovery.js";

/** Explicit old Link ownership only. Arbitrary MCP/OAuth/model credentials are excluded. */
export function isLegacyLinkConnection(value: Credential): boolean {
  const meta = value.meta as (Credential["meta"] & { recordSchemaVersion?: unknown }) | undefined;
  if (
    !meta ||
    meta.recordSchemaVersion !== undefined ||
    typeof meta.linkProvider !== "string" ||
    !/^[a-z0-9_.-]{1,100}$/.test(meta.linkProvider) ||
    typeof meta.linkConnectionMethod !== "string" ||
    !meta.linkConnectionMethod
  )
    return false;
  return (
    (value.type === "link" &&
      meta.linkExecutionRuntime === "local" &&
      ["http-token", "cli"].includes(meta.linkExecutionBackend ?? "")) ||
    (value.type === "oauth" &&
      meta.agentExposable === false &&
      ((meta.linkExecutionRuntime === "server" &&
        meta.linkExecutionBackend === "remote" &&
        !!meta.linkRemoteIssuer &&
        !!meta.linkRemoteGrantId) ||
        (meta.linkExecutionRuntime === "local" && meta.linkExecutionBackend === "mcp")))
  );
}

export interface LegacyLinkCleanupEntry {
  id: string;
  provider: string;
  scope: CredentialScope;
  remote: boolean;
}

function candidates(store: CredentialStore, scope: "full" | "project") {
  const layers: CredentialScope[] = scope === "full" ? ["user", "project"] : ["project"];
  return layers.flatMap((layer) => {
    const result = store.listLayerWithStatus(layer);
    if (!result.readable) throw new Error("Legacy Link credential layer is unreadable");
    return result.credentials.filter(isLegacyLinkConnection).map((credential) => ({
      credential,
      scope: layer,
    }));
  });
}

/** No secrets, labels, private account identity or credential bytes in the preview. */
export function previewLegacyLinkCleanup(store: CredentialStore, scope: "full" | "project") {
  return candidates(store, scope).map(
    ({ credential, scope }): LegacyLinkCleanupEntry => ({
      id: credential.id,
      provider: credential.meta!.linkProvider!,
      scope,
      remote: isRemoteLinkCredential(credential),
    }),
  );
}

/**
 * Offline maintenance, after all Hosts/workers using these stores have stopped.
 * Deletes selected old records, never ledgers, sessions, files or external CLI logins.
 * Existing private remote retirement custody survives and remains retryable by the Host.
 */
export function cleanupLegacyLinkConnections(options: {
  store: CredentialStore;
  scope: "full" | "project";
  /** All operation roots sharing these credentials, including custom SDK roots. */
  operationRoots: readonly string[];
  /** Host must fence/cancel users of the old records before returning. CLI is offline. */
  onDisabled?: () => void;
}): {
  removed: LegacyLinkCleanupEntry[];
  changed: LegacyLinkCleanupEntry[];
  remoteCleanupPending: number;
} {
  if (!options.operationRoots.length)
    throw new Error("Operation roots are required for Link cleanup");
  const selected = candidates(options.store, options.scope);
  const ledgers = options.operationRoots.map((root) => new OperationLedger(root));
  for (const ledger of ledgers)
    ledger.setConflictScopeResolver("github", GITHUB_OPERATION_CONFLICT_SCOPE);
  // Durable proof is independent of old connection records; unknown identities fence a provider.
  for (const provider of new Set(selected.map(({ credential }) => credential.meta!.linkProvider!)))
    for (const ledger of ledgers) ledger.protectUnresolvedWrites(provider);
  const disabled: typeof selected = [];
  const changed: LegacyLinkCleanupEntry[] = [];
  const entry = (credential: Credential, scope: CredentialScope): LegacyLinkCleanupEntry => ({
    id: credential.id,
    provider: credential.meta!.linkProvider!,
    scope,
    remote: isRemoteLinkCredential(credential),
  });
  for (const item of selected) {
    const next: Credential = {
      ...item.credential,
      autoUseByAI: false,
      exposeAsEnv: undefined,
      meta: { ...item.credential.meta, linkCleanupDisabled: true },
    };
    if (options.store.compareAndSwap(item.scope, item.credential.id, item.credential, next))
      disabled.push({ scope: item.scope, credential: next });
    else changed.push(entry(item.credential, item.scope));
  }
  options.onDisabled?.();
  const removed: LegacyLinkCleanupEntry[] = [];
  for (const { credential, scope } of disabled) {
    const remote = isRemoteLinkCredential(credential);
    // Project removal and user custody are separate writes. A failed removal leaves an
    // active matching grant, which the existing retirement claim refuses to revoke.
    if (remote && scope === "project")
      options.store.stageRemoteLinkRetirement(credential, Date.now());
    if (
      options.store.compareAndSwap(
        scope,
        credential.id,
        credential,
        null,
        remote && scope === "user" ? { retireExpected: true, now: Date.now() } : undefined,
      )
    )
      removed.push(entry(credential, scope));
    else changed.push(entry(credential, scope));
  }
  return { removed, changed, remoteCleanupPending: options.store.remoteLinkRetirementCount() };
}
