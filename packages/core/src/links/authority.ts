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
