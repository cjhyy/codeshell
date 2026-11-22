import {
  EncryptedGrantStore,
  grantCustody,
  type AsyncGrantCipher,
  type GrantCustody,
  type RelaySecretCipher,
} from "@cjhyy/code-shell-core/internal/storage";
export type { RelaySecretCipher } from "@cjhyy/code-shell-core/internal/storage";
import { isRelayHostId, isRelayOrigin, isRelayToken } from "@cjhyy/code-shell-server/remote-relay";

export interface RelayRegistration {
  relayOrigin: string;
  publicOrigin: string;
  hostId: string;
  environmentId: string;
  credential: string;
  credentialEpoch: number;
  protocolVersion: 1;
  name: string;
  accountId?: string;
  refreshToken?: string;
  credentialExpiresAt?: number;
  /** Local account preference; absent on older registrations means remote access is off. */
  remoteAccessEnabled?: boolean;
}
export function validRegistration(value: unknown): value is RelayRegistration {
  const data = value as RelayRegistration | undefined;
  return (
    !!data &&
    isRelayOrigin(data.relayOrigin) &&
    isRelayOrigin(data.publicOrigin) &&
    isRelayHostId(data.hostId) &&
    isRelayHostId(data.environmentId) &&
    isRelayToken(data.credential) &&
    Number.isSafeInteger(data.credentialEpoch) &&
    data.credentialEpoch > 0 &&
    data.protocolVersion === 1 &&
    typeof data.name === "string" &&
    data.name.length > 0 &&
    data.name.length <= 100 &&
    (data.remoteAccessEnabled === undefined || typeof data.remoteAccessEnabled === "boolean") &&
    (data.accountId === undefined
      ? data.refreshToken === undefined && data.credentialExpiresAt === undefined
      : isRelayHostId(data.accountId) &&
        isRelayToken(data.refreshToken) &&
        Number.isSafeInteger(data.credentialExpiresAt) &&
        data.credentialExpiresAt! > 0)
  );
}

/** OS custody accepts only the known relay registration fields, including for a legacy grant. */
export function relayGrantCustody(
  path: string,
  cipher: AsyncGrantCipher,
): GrantCustody<RelayRegistration> {
  const custody = grantCustody(path, cipher, validRegistration);
  const project = (grant: RelayRegistration): RelayRegistration => {
    if (!validRegistration(grant)) throw Error("设备登记无效。");
    const {
      relayOrigin,
      publicOrigin,
      hostId,
      environmentId,
      credential,
      credentialEpoch,
      protocolVersion,
      name,
      accountId,
      refreshToken,
      credentialExpiresAt,
      remoteAccessEnabled,
    } = grant;
    return {
      relayOrigin,
      publicOrigin,
      hostId,
      environmentId,
      credential,
      credentialEpoch,
      protocolVersion,
      name,
      accountId,
      refreshToken,
      credentialExpiresAt,
      remoteAccessEnabled,
    };
  };
  return {
    checkKeyring: () => custody.checkKeyring(),
    async readSaved() {
      const saved = await custody.readSaved();
      return saved && project(saved);
    },
    seal: (grant) => custody.seal(project(grant)),
  };
}

/** Separate from generic credentials: no renderer enumeration/export path. */
export class DeviceRelayStore extends EncryptedGrantStore<RelayRegistration> {
  constructor(path: string, cipher: RelaySecretCipher) {
    super(path, cipher, validRegistration);
  }
}
