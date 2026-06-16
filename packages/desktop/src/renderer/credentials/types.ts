export interface CredentialView {
  id: string;
  type: "token" | "link";
  label: string;
  secret?: string;
  exposeAsEnv?: string;
  meta?: { appUrl?: string };
}
export interface MaskedCredentialView extends Omit<CredentialView, "secret"> {
  hasSecret: boolean;
  secretHint?: string;
}
