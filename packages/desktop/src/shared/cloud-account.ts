/** Public account state. Tokens and OAuth receipts never cross the preload bridge. */
export const DEFAULT_CLOUD_ACCOUNT_ORIGIN = "https://115.159.45.55";

export interface CloudAccountIdentity {
  id: string;
  username: string;
  /** Optional for grants saved before profile support. */
  displayName?: string;
}

export interface CloudAccountStatus {
  state: "signed-out" | "signed-in" | "signing-in" | "storage-error";
  origin?: string;
  account?: CloudAccountIdentity;
  /** Data connection progress; independent from the account session and never persisted here. */
  githubConnection?: { state: "pending" | "connected" | "failed" | "skipped" };
}

/** Local credentials are erased even when the service cannot acknowledge revocation. */
export interface CloudAccountLogoutResult {
  state: "signed-out";
  revocation: "confirmed" | "unconfirmed";
}

export interface CloudAccountLogin {
  origin: string;
  username: string;
  password: string;
  deviceName?: string;
}

export interface CloudAccountCapabilities {
  registrationAllowed: boolean;
  githubEnabled: boolean;
  githubLinkEnabled?: boolean;
  linkManagementEnabled?: boolean;
  profileEnabled?: boolean;
}

export type CloudAccountProfileRequest = { origin: string; accountId: string } & (
  | { action: "read" }
  | { action: "update"; displayName?: string; username?: string }
);

/** Account-owned metadata only. Provider credentials and global clients are never exposed. */
export interface CloudAccountLinkView {
  linkOrigin: string;
  connections: Array<{
    id: string;
    provider: string;
    account: { id: string; login?: string; label?: string };
    revoked: boolean;
  }>;
  grants: Array<{
    id: string;
    connectionId: string;
    client: { id: string; name: string };
    scopes: string[];
    resources: string[];
    revoked: boolean;
  }>;
}

export type CloudAccountLinksRequest = { origin: string; accountId: string } & (
  | { action: "list" }
  | { action: "revoke"; kind: "connections" | "grants"; id: string }
);
export type CloudAccountLinksResult =
  | { action: "list"; view: CloudAccountLinkView }
  | { action: "revoke"; revoked: true; kind: "connections" | "grants"; id: string };

export type CloudAccountGitHubRequest =
  | { mode: "login"; input: CloudAccountGitHubLogin }
  | { mode: "link" };

export interface CloudAccountGitHubLogin {
  origin: string;
  deviceName?: string;
  connectGitHub?: boolean;
}

export interface CloudAccountApi {
  status(): Promise<CloudAccountStatus>;
  capabilities(origin: string): Promise<CloudAccountCapabilities>;
  login(input: CloudAccountLogin): Promise<CloudAccountStatus>;
  register(input: CloudAccountLogin): Promise<CloudAccountStatus>;
  signInWithGitHub(input: CloudAccountGitHubLogin): Promise<CloudAccountStatus>;
  linkGitHub(): Promise<CloudAccountStatus>;
  manageLinks(input: CloudAccountLinksRequest): Promise<CloudAccountLinksResult>;
  profile(input: CloudAccountProfileRequest): Promise<CloudAccountStatus>;
  cancelSignIn(): Promise<void>;
  logout(): Promise<CloudAccountLogoutResult>;
  onStatus(callback: (status: CloudAccountStatus) => void): () => void;
}
