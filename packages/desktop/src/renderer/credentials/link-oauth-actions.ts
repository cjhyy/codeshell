import type { MaskedCredentialView } from "./types";

export type LinkOAuthPrimaryAction = "login" | "refresh" | "unsupported";

/** Select the recoverable host action without treating provider invalid_grant as retryable. */
export function linkOAuthPrimaryAction(
  credential: MaskedCredentialView | undefined,
  hasAuditedProfile: boolean,
): LinkOAuthPrimaryAction {
  if (!credential) return hasAuditedProfile ? "login" : "unsupported";
  if (credential.meta?.lastRefreshErrorCode === "invalid_grant" && hasAuditedProfile) {
    return "login";
  }
  return "refresh";
}
