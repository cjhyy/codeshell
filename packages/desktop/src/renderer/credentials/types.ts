export interface CredentialView {
  id: string;
  type: "token" | "link" | "cookie";
  label: string;
  secret?: string;
  exposeAsEnv?: string;
  /** 逐条「AI 可自动取用」开关(免审批门)。 */
  autoUseByAI?: boolean;
  meta?: { appUrl?: string; platform?: string; domain?: string; scope?: "domain" | "all" };
}
export interface MaskedCredentialView extends Omit<CredentialView, "secret"> {
  hasSecret: boolean;
  secretHint?: string;
}
