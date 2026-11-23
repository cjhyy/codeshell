import type { SavedCloudAccount } from "./store.js";

export function savedGrant(value: SavedCloudAccount, origin: string): SavedCloudAccount {
  return {
    origin,
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    accessTokenExpiresAt: value.accessTokenExpiresAt,
    refreshTokenExpiresAt: value.refreshTokenExpiresAt,
    sessionId: value.sessionId,
    account: {
      id: value.account.id,
      username: value.account.username,
      ...(value.account.displayName === undefined
        ? {}
        : { displayName: value.account.displayName }),
    },
    ...(value.kind === undefined ? {} : { kind: value.kind }),
    ...(value.audience === undefined ? {} : { audience: value.audience }),
    ...(value.hostId === undefined ? {} : { hostId: value.hostId }),
  };
}
