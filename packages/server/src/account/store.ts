import { isRelayHostId, isRelayOrigin, isRelayToken } from "../remote-relay/protocol.js";
import type { CloudAccountIdentity } from "./types.js";
import { normalizeCloudDisplayName } from "@cjhyy/code-shell-web/account-profile";
import {
  EncryptedGrantStore,
  AsyncEncryptedGrantStore,
  type AsyncGrantCipher,
  type RelaySecretCipher,
} from "@cjhyy/code-shell-core/internal/storage";
export type { RelaySecretCipher } from "@cjhyy/code-shell-core/internal/storage";

/** Main-process-only grants. Never return this type from an IPC handler. */
export interface CloudAccountGrant {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number;
  sessionId: string;
  account: CloudAccountIdentity;
  kind?: "account" | "device";
  audience?: string;
  hostId?: string;
}
export interface SavedCloudAccount extends CloudAccountGrant {
  origin: string;
}

export function validCloudAccountGrant(value: unknown): value is CloudAccountGrant {
  if (!value || typeof value !== "object") return false;
  const grant = value as CloudAccountGrant;
  return (
    isRelayToken(grant.accessToken) &&
    isRelayToken(grant.refreshToken) &&
    isRelayHostId(grant.sessionId) &&
    Number.isSafeInteger(grant.accessTokenExpiresAt) &&
    grant.accessTokenExpiresAt > 0 &&
    Number.isSafeInteger(grant.refreshTokenExpiresAt) &&
    grant.refreshTokenExpiresAt >= grant.accessTokenExpiresAt &&
    !!grant.account &&
    isRelayHostId(grant.account.id) &&
    typeof grant.account.username === "string" &&
    grant.account.username.length > 0 &&
    grant.account.username.length <= 128 &&
    (grant.account.displayName === undefined ||
      (typeof grant.account.displayName === "string" &&
        normalizeCloudDisplayName(grant.account.displayName) === grant.account.displayName)) &&
    (grant.kind === undefined || grant.kind === "account" || grant.kind === "device") &&
    (grant.audience === undefined || isRelayOrigin(grant.audience)) &&
    (grant.hostId === undefined || isRelayHostId(grant.hostId))
  );
}

function validSavedCloudAccount(value: unknown): value is SavedCloudAccount {
  return (
    validCloudAccountGrant(value) &&
    value.kind !== "device" &&
    isRelayOrigin((value as SavedCloudAccount).origin) &&
    (value.audience === undefined || value.audience === (value as SavedCloudAccount).origin)
  );
}

/** Independent from agent credentials; no plaintext fallback or generic enumeration. */
export class CloudAccountStore extends EncryptedGrantStore<SavedCloudAccount> {
  static asynchronous(path: string, cipher: AsyncGrantCipher) {
    return new AsyncEncryptedGrantStore(path, cipher, validSavedCloudAccount);
  }
  constructor(path: string, cipher: RelaySecretCipher) {
    super(path, cipher, validSavedCloudAccount);
  }
}
