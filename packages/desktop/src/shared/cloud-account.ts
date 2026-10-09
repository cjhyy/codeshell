/** Public account state. Tokens and OAuth receipts never cross the preload bridge. */
export interface CloudAccountIdentity {
  id: string;
  username: string;
}

export interface CloudAccountStatus {
  state: "signed-out" | "signed-in" | "signing-in" | "storage-error";
  origin?: string;
  account?: CloudAccountIdentity;
}

export interface CloudAccountLogin {
  origin: string;
  username: string;
  password: string;
  deviceName?: string;
}

export interface CloudAccountApi {
  status(): Promise<CloudAccountStatus>;
  login(input: CloudAccountLogin): Promise<CloudAccountStatus>;
  register(input: CloudAccountLogin): Promise<CloudAccountStatus>;
  signInWithGitHub(input: { origin: string; deviceName?: string }): Promise<CloudAccountStatus>;
  linkGitHub(): Promise<CloudAccountStatus>;
  cancelSignIn(): Promise<void>;
  logout(): Promise<void>;
  onStatus(callback: (status: CloudAccountStatus) => void): () => void;
}
