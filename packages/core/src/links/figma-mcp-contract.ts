import { FIGMA_MCP_SERVER_URL, linkConnectionMetadata } from "@cjhyy/code-shell-link";
import type { CredentialMetadata } from "../credentials/access.js";

/** Metadata and reviewed errors must not load the MCP execution/tool registry. */
export interface McpLinkActionRequest {
  cwd?: string;
  id: string;
  scope: "full" | "project";
  accountId: string;
  verifiedAt: string;
  action: string;
  params: Record<string, unknown>;
}

export class McpLinkActionError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "changed"
      | "forbidden"
      | "reconnect"
      | "unsupported"
      | "response_too_large"
      | "resource_not_discovered"
      | "provider_error",
  ) {
    super(
      {
        invalid_request: "Invalid Figma MCP request.",
        changed: "Figma MCP connection changed; select the connection again.",
        forbidden: "This Figma connection does not grant the requested MCP action.",
        reconnect: "Figma MCP authorization requires reconnection in Figma Link.",
        unsupported: "This Figma MCP connection does not provide the requested capability.",
        response_too_large:
          "Figma MCP response exceeded 8 MiB. Read selected nodes or individual source resources instead.",
        resource_not_discovered:
          "Discover this Make file with get_design_context or list_resources on the same connection before reading a returned resource URI.",
        provider_error:
          "Figma MCP could not complete this request. Check the connection, file access, and available capabilities.",
      }[code],
    );
    this.name = "McpLinkActionError";
  }
}

export function isFigmaMcpCredential(
  credential: Pick<CredentialMetadata, "type" | "meta">,
): boolean {
  return (
    credential.type === "oauth" &&
    credential.meta?.linkProvider === "figma" &&
    String(linkConnectionMetadata(credential.meta).linkExecutionBackend) === "mcp" &&
    String(linkConnectionMetadata(credential.meta).linkAuthSource) === "mcp-oauth" &&
    linkConnectionMetadata(credential.meta).linkExecutionRuntime === "local" &&
    credential.meta.mcpServerUrl === FIGMA_MCP_SERVER_URL
  );
}
