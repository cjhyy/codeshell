/** Figma-owned routing metadata. Host credentials and MCP lifecycle stay outside this package. */
export const FIGMA_MCP_SERVER_URL = "https://mcp.figma.com/mcp";
export const FIGMA_MCP_SCOPE = "mcp:connect";
/** User-requested registration name verified against the official endpoint. */
export const FIGMA_MCP_REGISTRATION_CLIENT_NAME = "Codex";

export const FIGMA_MCP_TOOL_IDS = [
  "get_metadata",
  "get_design_context",
  "get_screenshot",
  "get_variable_defs",
  "get_motion_context",
  "get_figjam",
  "get_code_connect_map",
  "get_libraries",
  "search_design_system",
] as const;

/** These actions are always read-only; newly discovered upstream tools are never auto-enabled. */
export const FIGMA_MCP_ACTION_IDS = [
  ...FIGMA_MCP_TOOL_IDS,
  "list_resources",
  "read_resource",
] as const;
export type FigmaMcpActionId = (typeof FIGMA_MCP_ACTION_IDS)[number];

export function isFigmaMcpAction(action: string): action is FigmaMcpActionId {
  return (FIGMA_MCP_ACTION_IDS as readonly string[]).includes(action);
}
