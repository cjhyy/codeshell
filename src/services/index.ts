/**
 * Services index — re-exports all service modules.
 */

export { analytics, trackEvent } from "./analytics.js";
export {
  compactionService,
  microCompact,
  shouldAutoCompact,
  buildCompactionPrompt,
  applyCompaction,
  type CompactionConfig,
  type CompactionResult,
} from "./compact.js";
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
