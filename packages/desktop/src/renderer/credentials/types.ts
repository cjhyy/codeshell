export interface CredentialView {
  id: string;
  type: "token" | "link" | "cookie";
  label: string;
  secret?: string;
  exposeAsEnv?: string;
  meta?: { appUrl?: string; platform?: string; domain?: string };
}
export interface MaskedCredentialView extends Omit<CredentialView, "secret"> {
  hasSecret: boolean;
  secretHint?: string;
}
