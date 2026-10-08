import { credentialAccessScope, getCredentialAccess } from "../credentials/access.js";
import type { CredentialStatusFn } from "./resolve.js";

/** Probe global credential availability through renderer-safe metadata only. */
export const defaultCredentialStatus: CredentialStatusFn = (ref, context) => {
  const credential = getCredentialAccess().resolveMeta(
    context?.cwd,
    ref,
    context?.settingsScope ? credentialAccessScope(context.settingsScope) : "full",
  );
  if (!credential) return "missing";

  if (
    credential.type === "oauth" &&
    credential.oauthStatus?.state === "expired" &&
    !credential.oauthStatus.hasRefreshToken
  ) {
    return "expired";
  }

  return "ok";
};
