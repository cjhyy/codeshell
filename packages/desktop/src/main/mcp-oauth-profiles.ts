export interface McpOAuthProfile {
  id: string;
  provider: string;
  label: string;
  serverUrl: string;
  clientId?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  revocationEndpoint?: string;
  scopes?: string[];
}

/**
 * Audited catalog OAuth profiles. Keep this empty until an integration has
 * real client metadata or an MCP endpoint whose discovery supports DCR.
 */
export const MCP_OAUTH_PROFILES: Readonly<Record<string, McpOAuthProfile>> = Object.freeze({});
