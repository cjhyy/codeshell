/**
 * Stable extension contract for trusted in-process capability packages.
 * Product capabilities depend on this narrow entry instead of private core
 * paths, keeping the package graph one-way: capability -> core.
 */

export type {
  ClientDefaults,
  ContentBlock,
  LLMConfig,
  LLMResponse,
  Message,
  RegisteredTool,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from "./types.js";
export type { CreateMessageOptions } from "./llm/types.js";
export { LLMClientBase } from "./llm/client-base.js";
export { createLLMClient, registerProvider } from "./llm/client-factory.js";
export { ModelPool, type ModelEntry } from "./llm/model-pool.js";
export { logger } from "./logging/logger.js";
export { addTokenUsage } from "./engine/session-usage.js";
export { resolveMaxOutput } from "./onboarding.js";
export { SettingsManager, userHome } from "./settings/manager.js";
export { NOOP_COLORIZER, type Colorizer } from "./colorizer.js";
export type { ToolContext } from "./tool-system/context.js";
export { webSearchTool } from "./tool-system/builtin/web-search.js";
export { webFetchTool } from "./tool-system/builtin/web-fetch.js";
export { extractJSON, extractJSONArray } from "./utils/json.js";
export type {
  CapabilityModule,
  CapabilityQueryHandler,
  CapabilityTool,
} from "./tool-system/capability-module.js";
