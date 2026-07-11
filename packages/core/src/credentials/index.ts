export { CredentialStore } from "./store.js";
export type { CredentialScope, MaskedCredential } from "./store.js";
export {
  type EncryptionCipher,
  PlaintextCipher,
  setDefaultCredentialCipher,
  getDefaultCredentialCipher,
} from "./cipher.js";
export {
  getCredentialAccess,
  setDefaultCredentialAccess,
  createIpcCredentialAccess,
  localCredentialAccess,
  credentialAccessScope,
  isCredentialSecretAvailable,
  materializeCookieSecret,
  type CredentialAccess,
  type CredentialAccessScope,
  type CredentialMetadata,
  type CredentialSnapshot,
  type CredentialSnapshotEntry,
} from "./access.js";
export type {
  Credential,
  CredentialType,
  CredentialStoreFile,
  OAuthCredentialPublicStatus,
  OAuthCredentialSecret,
  OAuthTokenResponse,
} from "./types.js";
export { credentialAllowsEnvExposure, credentialSecretHint } from "./types.js";
export {
  buildOAuthRefreshRequest,
  isOAuthAccessTokenExpired,
  oauthCredentialStatus,
  parseOAuthCredentialSecret,
  mergeOAuthTokenResponse,
  shouldRefreshOAuthCredential,
  summarizeOAuthCredentialSecret,
  type OAuthClockOptions,
  type OAuthRefreshHandler,
  type OAuthRefreshRequest,
} from "./oauth.js";
export { formatNetscapeCookies, parseCookieJar, type CookieLike } from "./cookie-jar.js";
export {
  useCredentialToolDef,
  useCredentialToolDefFor,
  useCredentialTool,
  sweepStaleCredentialCookies,
} from "./use-credential-tool.js";
export { credentialUseGate } from "./use-gate.js";
