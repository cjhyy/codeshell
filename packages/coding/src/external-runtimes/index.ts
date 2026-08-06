/**
 * External Agent Runtimes: driving Claude Code / Codex as execution backends and
 * letting them call CodeShell tools back through one loopback MCP bridge.
 *
 * The reverse tool channel is runtime-AGNOSTIC (`shared/`). That was not the
 * original plan — the design assumed Claude Code would need an in-process MCP
 * server via `@anthropic-ai/claude-agent-sdk`. It turns out `claude --mcp-config`
 * accepts an HTTP MCP server with an `Authorization` header, exactly as Codex
 * does, so both runtimes share one transport and CodeShell takes on no new
 * dependency. Verified end-to-end against real `codex-cli 0.145.0` and real
 * `claude 2.1.220` — see `docs/todo/evidence/`.
 *
 * The one real difference: Codex injects a per-call `_meta.threadId`, so a single
 * bridge can serve many concurrent threads. Claude Code sends no equivalent, so
 * its bridge is pinned to one session and the PORT is the attribution.
 */
export {
  CODEX_MCP_TOKEN_ENV_VAR,
  codexBridgeConfigArgs,
  startLoopbackMcpBridge,
  threadIdFromMeta,
} from "./shared/mcp-bridge.js";
export type { BridgeToolHost, McpBridgeHandle, McpBridgeOptions } from "./shared/mcp-bridge.js";
export { SessionContextStore } from "./shared/session-context-store.js";
export type {
  ResolveRequest,
  SessionContextResult,
  SessionContextMissReason,
  ToolHostRef,
} from "./shared/session-context-store.js";
export { buildRuntimeSpawnEnv } from "./shared/spawn-env.js";
export type { RuntimeSpawnEnvOptions } from "./shared/spawn-env.js";
export { textWithAttachmentReferences } from "./turn-input.js";
export type { ExternalRuntimeAttachment, ExternalRuntimeTurnInput } from "./turn-input.js";
export { CodexEventTranslator } from "./codex/event-translator.js";
export { CodexAppServerClient } from "./codex/app-server-client.js";
export type { AppServerClientOptions } from "./codex/app-server-client.js";
export { CodexRuntime } from "./codex/runtime.js";
export type {
  CodexRuntimeOptions,
  CodexRuntimeHooks,
  CodexTurnHandle,
  NativeApprovalDecision,
} from "./codex/runtime.js";
export {
  buildClaudeMcpConfig,
  claudeAllowedToolNames,
  claudeBridgeArgs,
  CLAUDE_MCP_SERVER_NAME,
} from "./claude-code/mcp-config.js";
export type { ClaudeMcpConfigOptions, ClaudeMcpConfigFile } from "./claude-code/mcp-config.js";
export { writeClaudeMcpConfigFile } from "./claude-code/mcp-config.js";
export { ClaudeEventTranslator } from "./claude-code/event-translator.js";
export type { ClaudeEventTranslatorOptions } from "./claude-code/event-translator.js";
export { ClaudeCodeRuntime } from "./claude-code/runtime.js";
export type {
  ClaudeRuntimeOptions,
  ClaudeRuntimeHooks,
  ClaudeTurnHandle,
} from "./claude-code/runtime.js";
export type { CodexEventTranslatorOptions } from "./codex/event-translator.js";
export { startExternalRuntimeSession } from "./session-factory.js";
export type {
  ExternalRuntimeKind,
  ExternalRuntimeSession,
  ExternalRuntimeSessionOptions,
} from "./session-factory.js";
