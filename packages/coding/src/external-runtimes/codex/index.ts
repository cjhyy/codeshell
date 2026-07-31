/**
 * Codex external-runtime plumbing: the loopback MCP bridge and the thread
 * context store that keeps concurrent threads apart.
 *
 * The Runtime/session driver (app-server client, event translator) is not here
 * yet — this is the reverse tool channel only, which is the half that carries
 * the security burden.
 */
export {
  CODEX_MCP_TOKEN_ENV_VAR,
  codexBridgeConfigArgs,
  startCodexMcpBridge,
  threadIdFromMeta,
} from "./mcp-bridge.js";
export type { BridgeToolHost, McpBridgeHandle, McpBridgeOptions } from "./mcp-bridge.js";
export { CodexThreadContextStore } from "./thread-context-store.js";
export type {
  CodexToolHostRef,
  ResolveRequest,
  ThreadContextMissReason,
  ThreadContextResult,
} from "./thread-context-store.js";
