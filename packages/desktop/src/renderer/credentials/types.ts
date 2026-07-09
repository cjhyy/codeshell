export interface CredentialView {
  id: string;
  type: "token" | "link" | "cookie" | "oauth";
  label: string;
  secret?: string;
  exposeAsEnv?: string;
  /** 逐条「AI 可自动取用」开关(取 cookie 文件走 HTTP,免审批门)。 */
  autoUseByAI?: boolean;
  /** 逐条「AI 可自动注入浏览器」开关(把 cookie 灌进内置浏览器,免审批门)。 */
  autoInjectByAI?: boolean;
  meta?: {
    appUrl?: string;
    platform?: string;
    domain?: string;
    scope?: "domain" | "all";
    switchMode?: "clear" | "merge";
    oauthProvider?: string;
    authUrl?: string;
    tokenEndpoint?: string;
    clientId?: string;
    scopes?: string[];
    lastRefreshAt?: string;
  };
}
export interface MaskedCredentialView extends Omit<CredentialView, "secret"> {
  hasSecret: boolean;
  secretHint?: string;
  oauthStatus?: {
    state: "valid" | "expired" | "missing" | "invalid";
    expiresAt?: string;
    expiresInMs?: number;
    hasRefreshToken?: boolean;
    tokenEndpoint?: string;
    clientId?: string;
    scope?: string;
    scopes?: string[];
    error?: string;
  };
}
