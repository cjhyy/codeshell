/**
 * Services index — re-exports all service modules.
 */

export { analytics, trackEvent } from "./analytics.js";
// NOTE: ./compact.ts was a stand-alone stub that duplicated the real
// microcompact/autocompact logic now living in src/context/. It was never
// wired into Engine and shipped with incompatible semantics (a single
// `microCompact` that truncated long *messages* by char count, unrelated
// to the tool_result-based microcompact in ContextManager). Removed to end
// the "which microcompact?" ambiguity — the source of truth is ContextManager.
export { authorize, refreshToken, type OAuthConfig, type OAuthTokens } from "./oauth.js";
export { notify, notifyComplete, notifyError } from "./notifier.js";
export { diagnostics } from "./diagnostics.js";
export {
  buildExtractionPrompt,
  parseExtractionResponse,
  type ExtractedMemory,
} from "./extract-memories.js";
export {
  shouldAutoDream,
  recordSession,
  recordDreamComplete,
  buildDreamPrompt,
} from "./auto-dream.js";
export {
  saveSessionMemory,
  loadSessionMemory,
  listSessionMemories,
  searchSessionMemories,
  buildSessionMemoryPrompt,
} from "./session-memory.js";
export {
  MemoryOrchestrator,
  type MemoryOrchestratorOptions,
  type MemoryOrchestratorResult,
} from "./memory-orchestrator.js";
