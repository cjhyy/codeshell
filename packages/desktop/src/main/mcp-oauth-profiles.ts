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
  /** Trusted Host registration metadata, never accepted from renderer login input. */
  registrationClientName?: string;
}

/**
 * Trusted Host integrations. Registration metadata never comes from renderer inputs.
 */
export const MCP_OAUTH_PROFILES: Readonly<Record<string, McpOAuthProfile>> = Object.freeze({
  "figma-mcp": {
    id: "figma-mcp",
    provider: "figma",
    label: "Figma MCP",
    serverUrl: FIGMA_MCP_SERVER_URL,
    scopes: [FIGMA_MCP_SCOPE],
    registrationClientName: FIGMA_MCP_REGISTRATION_CLIENT_NAME,
  },
});
import {
  FIGMA_MCP_SERVER_URL,
  FIGMA_MCP_SCOPE,
  FIGMA_MCP_REGISTRATION_CLIENT_NAME,
} from "@cjhyy/code-shell-link";
