import { githubStarActionIds } from "./github-star.js";
import { getLocalLinkProvider } from "./providers.js";
import type { CredentialMetadata } from "../credentials/access.js";

/** Public authority only. Rotating tokens/expiry are deliberately excluded. */
export function linkAuthoritySnapshot(credential: CredentialMetadata): string {
  const meta = credential.meta;
  return JSON.stringify({
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
    legacyResources: meta?.linkResourceLabels,
    authSource: meta?.linkAuthSource,
    remoteState: meta?.linkRemoteState,
    verifiedAt: meta?.linkLastVerifiedAt,
    clientId: credential.oauthStatus?.clientId ?? meta?.clientId,
    tokenEndpoint: credential.oauthStatus?.tokenEndpoint ?? meta?.tokenEndpoint,
    oauthScope: credential.oauthStatus?.scope,
    oauthScopes: credential.oauthStatus?.scopes,
  });
}

/** New actions require an explicit saved grant; legacy unscoped bindings never expand. */
export function allowsLinkAction(
  credential: CredentialMetadata,
  provider: string,
  action: string,
): boolean {
  if (
    credential.meta?.linkExecutionBackend === "cli" &&
    getLocalLinkProvider(provider)?.actions.find((candidate) => candidate.id === action)?.risk ===
      "write"
  )
    return false;
  const ids = credential.meta?.linkCapabilityIds;
  if (
    credential.meta?.linkExecutionRuntime === "server" ||
    (provider === "github" && (githubStarActionIds as readonly string[]).includes(action))
  )
    return ids?.includes(`${provider}.${action}`) === true;
  return !ids?.length || ids.includes(`${provider}.${action}`);
}
