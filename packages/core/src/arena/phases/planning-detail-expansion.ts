/**
 * PlanningDetailExpansion — expands high-level roadmap phases into
 * repo-level implementation plans.
 *
 * This phase is planning-mode specific. It takes the roadmap produced
 * by consensus and, for each phase, calls the LLM to produce concrete
 * implementation details: target files, code changes, interfaces,
 * migration steps, validation, effort, and blockers.
 *
 * Tool access is available so the LLM can verify file paths and interfaces.
 */

import { createLLMClient } from "../../llm/client-factory.js";
import { logger } from "../../logging/logger.js";
import type {
  ArenaParticipant,
  ArenaRoadmapPhase,
  ArenaRoadmapPhaseDetail,
  ArenaProgressEvent,
  ArenaExecutionLimits,
  ArenaStrategyPlanning,
} from "../types.js";
import type { ToolDefinition, Message, ContentBlock, ToolCall } from "../../types.js";
import type { ArenaLedger } from "../ledger.js";
import { buildDigest } from "../digest-builder.js";
import { CONTEXT_TOOLS, MAX_TOOL_ROUNDS, executeContextTool } from "../context/context-tools.js";

interface DetailExpansionOptions {
  /** The participant that performs the expansion (typically the concluder) */
  concluder: ArenaParticipant;
  strategy: ArenaStrategyPlanning;
  topic: string;
  /** Roadmap phases to expand */
  phases: ArenaRoadmapPhase[];
  ledger: ArenaLedger;
  limits: ArenaExecutionLimits;
  /** Enable read-only context tools for file path verification */
  enableContextTools?: boolean;
  /** Plan-selected tools override */
  contextTools?: ToolDefinition[];
  signal?: AbortSignal;
  onProgress?: (event: ArenaProgressEvent) => void;
}

/** Max tool rounds per phase expansion (lighter than research) */
const MAX_EXPANSION_TOOL_ROUNDS = 3;

/**
 * Expand each roadmap phase into a repo-level implementation plan.
 *
 * Phases are expanded sequentially to avoid token explosion.
 * The number of phases expanded is capped by limits.maxExpandedPhasesPerRun.
 */
export async function runDetailExpansion(
  options: DetailExpansionOptions,
): Promise<ArenaRoadmapPhaseDetail[]> {
  const { concluder, strategy, topic, phases, ledger, limits, signal, onProgress } = options;
  const tools = options.enableContextTools !== false
    ? (options.contextTools ?? CONTEXT_TOOLS)
    : undefined;

  // Cap phases to expand
  const toExpand = phases.slice(0, limits.maxExpandedPhasesPerRun);

  onProgress?.({ type: "roadmap_expansion_start", phaseCount: toExpand.length });
  logger.info("arena.detail_expansion_start", { phaseCount: toExpand.length });

  const details: ArenaRoadmapPhaseDetail[] = [];

  const client = await createLLMClient({
    ...concluder.llm,
    enableStreaming: false,
  });

  const systemPrompt = strategy.detailExpansionSystemPrompt();

  // Expand each phase sequentially
  for (const phase of toExpand) {
    signal?.throwIfAborted();

    // Build phase-specific digest using related findings
    const relevantClaimIds = phase.relatedFindings ?? [];
    const digest = buildDigest(ledger, { round: 1, relevantClaimIds });

    const userContent = strategy.detailExpansionUserPrompt(topic, phase, digest);

    const messages: Message[] = [{ role: "user", content: userContent }];
    let finalText = "";

    // Tool-use loop: allow LLM to verify file paths and interfaces
    const maxRounds = tools ? Math.min(MAX_EXPANSION_TOOL_ROUNDS, MAX_TOOL_ROUNDS) : 0;
    for (let round = 0; round <= maxRounds; round++) {
      const response = await client.createMessage({
        systemPrompt,
        messages,
        tools,
        signal,
      });

      const hasTools = response.toolCalls && response.toolCalls.length > 0;

      logger.info("arena.detail_expansion_round", {
        phase: phase.title,
        round,
        toolCount: response.toolCalls?.length ?? 0,
        stopReason: response.stopReason,
      });

      if (!hasTools) {
        finalText = response.text;
        break;
      }

      // Append assistant message with tool_use blocks
      const assistantBlocks: ContentBlock[] = [];
      if (response.text) {
        assistantBlocks.push({ type: "text", text: response.text });
      }
      for (const tc of response.toolCalls!) {
        assistantBlocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.toolName,
          input: tc.args,
        });
      }
      messages.push({ role: "assistant", content: assistantBlocks });

      // Execute tools and append results
      const toolResultBlocks: ContentBlock[] = [];
      for (const tc of response.toolCalls!) {
        const result = executeContextTool(tc);
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: tc.id,
          content: result.slice(0, 15_000),
        });
      }
      messages.push({ role: "user", content: toolResultBlocks });

      // Last round: force a text response
      if (round === maxRounds) {
        finalText = response.text;
      }
    }

    // Retry if truncated
    if (!finalText) {
      finalText = "";
    }

    logger.info("arena.detail_expansion_phase", {
      phase: phase.title,
      textLen: finalText.length,
    });

    const detail = strategy.parseDetailExpansionResponse(finalText);
    if (!detail.phaseTitle) detail.phaseTitle = phase.title;

    // Log parse quality
    if (detail.targetFiles.length === 0 && detail.codeChanges.length === 0) {
      logger.warn("arena.detail_expansion_sparse", {
        phase: phase.title,
        objective: detail.objective.slice(0, 200),
      });
    }

    details.push(detail);
  }

  logger.info("arena.detail_expansion_done", { detailCount: details.length });
  onProgress?.({ type: "roadmap_expansion_done", detailCount: details.length });

  return details;
}
