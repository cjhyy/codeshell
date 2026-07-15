import { getCredentialAccess } from "../credentials/access.js";

/** Probe global credential availability through renderer-safe metadata only. */
export function defaultCredentialStatus(ref: string): "ok" | "missing" | "expired" {
  const credential = getCredentialAccess().resolveMeta(undefined, ref, "full");
  if (!credential) return "missing";

  if (
    credential.type === "oauth" &&
    credential.oauthStatus?.state === "expired" &&
    !credential.oauthStatus.hasRefreshToken
  ) {
    return "expired";
  }

  return "ok";
}
