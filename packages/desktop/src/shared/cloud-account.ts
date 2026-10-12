/** Public account state. Tokens and OAuth receipts never cross the preload bridge. */
export const DEFAULT_CLOUD_ACCOUNT_ORIGIN = "https://115.159.45.55";

export interface CloudAccountIdentity {
  id: string;
  username: string;
}

export interface CloudAccountStatus {
  state: "signed-out" | "signed-in" | "signing-in" | "storage-error";
  origin?: string;
  account?: CloudAccountIdentity;
  /** Data connection progress; independent from the account session and never persisted here. */
  githubConnection?: { state: "pending" | "connected" | "failed" | "skipped" };
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
}

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
  cancelSignIn(): Promise<void>;
  logout(): Promise<void>;
  onStatus(callback: (status: CloudAccountStatus) => void): () => void;
}
