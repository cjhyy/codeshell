/** External Claude Code/Codex orchestration and quota surface. */
export * from "./cc-orchestrator/index.js";
export { resolveExternalAgentConfig } from "./external-agents/config.js";
export type {
  ExternalAgentMode,
  ExternalAgentsSettings,
  ResolvedClaudeCodeSettings,
  ResolvedCodexSettings,
  ResolvedExternalAgentsConfig,
} from "./external-agents/types.js";
export { checkQuota, formatQuota } from "./quota/index.js";
export { resolveQuotaCredentials } from "./quota/credentials.js";
export type { ProviderQuota, QuotaCredentials, QuotaResult, QuotaWindow } from "./quota/types.js";
