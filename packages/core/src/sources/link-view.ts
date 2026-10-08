import { z } from "zod";
import { createHash } from "node:crypto";
import { credentialAccessScope, getCredentialAccess } from "../credentials/access.js";
import { getLocalLinkProvider } from "../links/providers.js";
import { isRemoteLinkCredential } from "../links/remote.js";
import type { SourceAdapterContext } from "./adapter.js";
import type { SourceDefinition } from "./types.js";

const LinkSourceConfigSchema = z
  .object({
    providerId: z.string().min(1).max(64),
    action: z.string().min(1).max(128),
    params: z.record(z.unknown()).default({}),
  })
  .strict();

/** A source pins one reviewed, read-only Link action and its parameters. */
export function linkSourceView(definition: SourceDefinition) {
  if (definition.kind !== "link" || !definition.credentialRef) {
    throw new Error("Link source requires an exact saved connection");
  }
  const config = LinkSourceConfigSchema.parse(definition.adapterConfig);
  const provider = getLocalLinkProvider(config.providerId);
  const action = provider?.actions.find((candidate) => candidate.id === config.action);
  if (!provider || !action || action.risk === "write") {
    throw new Error("Link source requires a supported read-only action");
  }
  const encoded = JSON.stringify(config.params);
  if (Buffer.byteLength(encoded, "utf8") > 16_384) {
    throw new Error("Link source parameters exceed the size limit");
  }
  return { ...config, scopeId: `${provider.id}:${action.id}`, title: action.title };
}

/** Metadata only: use the caller's credential scope, never decrypt or refresh. */
export function isLinkSourceAvailable(
  definition: SourceDefinition,
  context?: SourceAdapterContext,
): boolean {
  try {
    const view = linkSourceView(definition);
    const credential = getCredentialAccess().resolveMeta(
      context?.cwd,
      definition.credentialRef!,
      credentialAccessScope(context?.settingsScope),
    );
    if (!credential || !credential.hasSecret || credential.meta?.linkProvider !== view.providerId)
      return false;
    const remote = isRemoteLinkCredential(credential);
    if (
      !remote &&
      (credential.type !== "link" || credential.meta?.linkExecutionRuntime !== "local")
    )
      return false;
    if (remote && credential.meta?.linkRemoteState !== "connected") return false;
    if (credential.oauthStatus?.state === "expired" && !credential.oauthStatus.hasRefreshToken)
      return false;
    const capabilities = credential.meta?.linkCapabilityIds;
    return remote
      ? !!capabilities?.includes(`${view.providerId}.${view.action}`)
      : !capabilities?.length || capabilities.includes(`${view.providerId}.${view.action}`);
  } catch {
    return false;
  }
}

/** Pin account/grant/resource authority across approval; token rotation is not authority. */
export function linkSourceAuthorityRevision(
  definition: SourceDefinition,
  context?: SourceAdapterContext,
): string | undefined {
  const credential =
    definition.credentialRef &&
    getCredentialAccess().resolveMeta(
      context?.cwd,
      definition.credentialRef,
      credentialAccessScope(context?.settingsScope),
    );
  if (!credential) return undefined;
  const meta = credential.meta;
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: credential.id,
        type: credential.type,
        provider: meta?.linkProvider,
        runtime: meta?.linkExecutionRuntime,
        backend: meta?.linkExecutionBackend,
        account: meta?.linkAccountId,
        issuer: meta?.linkRemoteIssuer,
        connection: meta?.linkRemoteConnectionId,
        grant: meta?.linkRemoteGrantId,
        capabilities: meta?.linkCapabilityIds,
        resources: meta?.linkResourceGroups,
        verifiedAt: meta?.linkLastVerifiedAt,
      }),
    )
    .digest("hex");
}
