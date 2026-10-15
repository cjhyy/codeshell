import { createHash } from "node:crypto";
import type { ClientDefaults, LLMConfig, TokenUsage } from "../types.js";
import { createLLMClient } from "../llm/client-factory.js";
import type { ModelPool } from "../llm/model-pool.js";
import type { SettingsManager } from "../settings/manager.js";
import type { ToolRegistry } from "../tool-system/registry.js";
import type { ToolContext } from "../tool-system/context.js";
import type { Transcript } from "../session/transcript.js";
import { logger } from "../logging/logger.js";
import { sanitizeContent } from "../logging/sanitize-messages.js";
import { MemoryOrchestrator } from "../services/memory-orchestrator.js";
import { runDreamConsolidation } from "../services/dream-consolidation.js";
import { resolveAuxKey } from "./aux-key.js";
import type { CumulativeUsageCounters } from "../session/usage.js";
import type { EngineConfig } from "./types.js";
import type { UsagePurpose } from "../cost-ledger/types.js";

export type EngineLlmClient = Awaited<ReturnType<typeof createLLMClient>>;

export interface ResolvedAuxClient {
  client: EngineLlmClient;
  maxContextTokens: number;
}

export interface MemoriesConfig {
  maxCount?: number;
  maxAge?: number;
  extractionModel?: string;
  autoExtract?: boolean;
}

export function sameLlmIdentity(a: LLMConfig, b: LLMConfig): boolean {
  return (
    a.model === b.model &&
    (a.baseUrl ?? undefined) === (b.baseUrl ?? undefined) &&
    (a.provider ?? undefined) === (b.provider ?? undefined) &&
    (a.providerKind ?? undefined) === (b.providerKind ?? undefined) &&
    (a.maxTokens ?? undefined) === (b.maxTokens ?? undefined) &&
    a.supportsVision === b.supportsVision &&
    a.serviceTier === b.serviceTier &&
    a.reasoningSummary === b.reasoningSummary &&
    JSON.stringify(a.reasoning ?? null) === JSON.stringify(b.reasoning ?? null) &&
    JSON.stringify(a.extraBody ?? null) === JSON.stringify(b.extraBody ?? null)
  );
}

export function buildSummarizeFn(
  client: EngineLlmClient,
  recordCumulativeUsage?: (usage: TokenUsage) => CumulativeUsageCounters,
  purpose: UsagePurpose = "aux_summary",
): (prompt: string, signal?: AbortSignal) => Promise<string> {
  return async (prompt, signal) => {
    const response = await client.createMessage({
      systemPrompt: "You are a conversation summarizer. Be concise and factual.",
      messages: [{ role: "user", content: prompt }],
      tools: [],
      maxTokens: 1024,
      billingEnabled: true,
      requestVisible: false,
      usagePurpose: purpose,
      reasoning: { mode: "off" },
      signal,
    });
    if (response.usage) recordCumulativeUsage?.(response.usage);
    return response.text;
  };
}

export class AuxiliaryPipeline {
  private auxClientCache?: {
    key: string;
    fingerprint: string;
    fetch?: ClientDefaults["fetch"];
    client: EngineLlmClient;
  };

  constructor(
    private readonly deps: {
      config: () => EngineConfig;
      settings: () => SettingsManager;
      modelPool: () => ModelPool;
      toolRegistry: () => ToolRegistry;
      toolContext: () => ToolContext;
    },
  ) {}

  buildSummarizeFn(
    client: EngineLlmClient,
    recordCumulativeUsage?: (usage: TokenUsage) => CumulativeUsageCounters,
    purpose: UsagePurpose = "aux_summary",
  ): (prompt: string, signal?: AbortSignal) => Promise<string> {
    return buildSummarizeFn(client, recordCumulativeUsage, purpose);
  }

  readMemoriesConfig(): MemoriesConfig | undefined {
    try {
      return (this.deps.settings().get() as { memories?: MemoriesConfig }).memories;
    } catch {
      return undefined;
    }
  }

  async resolveAuxClient(fallback: EngineLlmClient): Promise<EngineLlmClient> {
    return (await this.resolveAuxClientWithMetadata(fallback)).client;
  }

  async resolveAuxClientWithMetadata(
    fallback: EngineLlmClient,
    fallbackMaxContextTokens = 200_000,
  ): Promise<ResolvedAuxClient> {
    let auxKey: string | undefined;
    try {
      const settings = this.deps.settings();
      settings.invalidate();
      auxKey = resolveAuxKey(settings.get() as { defaults?: { auxText?: string } });
    } catch {
      return { client: fallback, maxContextTokens: fallbackMaxContextTokens };
    }
    if (!auxKey) {
      this.auxClientCache = undefined;
      return { client: fallback, maxContextTokens: fallbackMaxContextTokens };
    }

    const modelPool = this.deps.modelPool();
    const entry = modelPool.get(auxKey);
    if (!entry) {
      this.auxClientCache = undefined;
      logger.warn("engine.aux_model_missing", { auxModelKey: auxKey });
      return { client: fallback, maxContextTokens: fallbackMaxContextTokens };
    }
    const llm = modelPool.toLLMConfig(entry);
    const config = this.deps.config();
    if (sameLlmIdentity(llm, config.llm)) {
      return {
        client: fallback,
        maxContextTokens: entry.maxContextTokens ?? fallbackMaxContextTokens,
      };
    }
    try {
      // Include credentials and all model metadata so reconfiguring the same
      // connection cannot retain an old client. Store only an in-memory digest;
      // the resolved configuration must never appear in cache diagnostics.
      const defaults = config.clientDefaults;
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ llm, defaults }))
        .digest("hex");
      if (
        this.auxClientCache?.key === auxKey &&
        this.auxClientCache.fingerprint === fingerprint &&
        this.auxClientCache.fetch === defaults?.fetch
      ) {
        return {
          client: this.auxClientCache.client,
          maxContextTokens: entry.maxContextTokens ?? fallbackMaxContextTokens,
        };
      }
      const client = await createLLMClient(llm, defaults);
      this.auxClientCache = { key: auxKey, fingerprint, fetch: defaults?.fetch, client };
      return {
        client,
        maxContextTokens: entry.maxContextTokens ?? fallbackMaxContextTokens,
      };
    } catch (error) {
      logger.warn("engine.aux_model_build_failed", {
        auxModelKey: auxKey,
        error: (error as Error).message,
      });
      return { client: fallback, maxContextTokens: fallbackMaxContextTokens };
    }
  }

  async runMemoryPipeline(
    transcript: Transcript,
    sessionId: string,
    cwd: string,
    primaryClient: EngineLlmClient,
    recordBilledUsage?: (usage: TokenUsage) => void,
  ): Promise<void> {
    try {
      const llmClient = await this.resolveExtractionClient(primaryClient);
      const messages = transcript
        .toMessages()
        .filter((message) => message.role === "user" || message.role === "assistant");
      if (messages.length < 8) return;

      const plainMessages = messages.map((message) => {
        const safe = sanitizeContent(message.content);
        return {
          role: message.role,
          content: typeof safe === "string" ? safe : JSON.stringify(safe),
        };
      });
      const memories = this.readMemoriesConfig();
      const orchestrator = new MemoryOrchestrator({
        callLLM: async (systemPrompt, userMessage) => {
          const response = await llmClient.createMessage({
            systemPrompt,
            messages: [{ role: "user", content: userMessage }],
            tools: [],
            maxTokens: 1024,
            billingEnabled: true,
            requestVisible: false,
            usagePurpose: "aux_summary",
            reasoning: { mode: "off" },
          });
          if (response.usage) recordBilledUsage?.(response.usage);
          return response.text;
        },
        runDream: async ({ projectDir, baseDir }) =>
          this.runDreamLoop({
            projectDir,
            baseDir,
            llmClient,
            sessionId,
            recordBilledUsage,
          }),
        projectDir: cwd,
        maxCount: memories?.maxCount,
        autoExtract: memories?.autoExtract,
      });

      await orchestrator.run(plainMessages, sessionId);
    } catch (error) {
      logger.warn("engine.memory_pipeline_failed", {
        sessionId,
        error: (error as Error).message,
      });
    }
  }

  private async runDreamLoop(options: {
    projectDir?: string;
    baseDir?: string;
    llmClient: EngineLlmClient;
    sessionId: string;
    recordBilledUsage?: (usage: TokenUsage) => void;
  }): Promise<boolean> {
    const { ran } = await runDreamConsolidation({
      baseDir: options.baseDir,
      llmClient: options.llmClient,
      toolRegistry: this.deps.toolRegistry(),
      toolContext: this.deps.toolContext(),
      projectDir: options.projectDir,
      sessionId: options.sessionId,
      onUsage: options.recordBilledUsage,
    });
    return ran;
  }

  private async resolveExtractionClient(primaryClient: EngineLlmClient): Promise<EngineLlmClient> {
    const key = this.readMemoriesConfig()?.extractionModel;
    const modelPool = this.deps.modelPool();
    if (key) {
      const entry = modelPool.get(key);
      if (entry) {
        try {
          return await createLLMClient(
            modelPool.toLLMConfig(entry),
            this.deps.config().clientDefaults,
          );
        } catch (error) {
          logger.warn("engine.extraction_model_build_failed", {
            extractionModel: key,
            error: (error as Error).message,
          });
        }
      } else {
        logger.warn("engine.extraction_model_missing", { extractionModel: key });
      }
    }
    return this.resolveAuxClient(primaryClient);
  }
}
