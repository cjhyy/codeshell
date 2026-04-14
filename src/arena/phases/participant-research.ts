/**
 * ParticipantResearch — each participant independently investigates
 * the shared base context and produces structured findings.
 *
 * Participants receive the same ArenaBaseContext but can independently
 * request additional context via tools, then output ArenaFinding[].
 */

import { createLLMClient } from "../../llm/client-factory.js";
import type { LLMClientBase } from "../../llm/client-base.js";
import type { Message, ContentBlock, ToolCall } from "../../types.js";
import type {
  ArenaBaseContext,
  ArenaParticipant,
  ArenaStrategy,
  ParticipantReport,
  ArenaProgressEvent,
} from "../types.js";
import { CONTEXT_TOOLS, MAX_TOOL_ROUNDS, executeContextTool } from "../context/context-tools.js";
import { logger } from "../../logging/logger.js";

interface ResearchOptions {
  participants: ArenaParticipant[];
  strategy: ArenaStrategy;
  topic: string;
  baseContext: ArenaBaseContext;
  enableContextTools?: boolean;
  onProgress?: (event: ArenaProgressEvent) => void;
}

/**
 * Run participant research phase in parallel.
 * Each participant reads the shared context, optionally requests more,
 * then produces structured findings.
 */
export async function runParticipantResearch(options: ResearchOptions): Promise<ParticipantReport[]> {
  const { participants, strategy, topic, baseContext, enableContextTools, onProgress } = options;
  const tools = enableContextTools ? CONTEXT_TOOLS : undefined;

  const tasks = participants.map(async (p) => {
    onProgress?.({ type: "research_start", participant: p.name });

    const client = await createLLMClient({
      ...p.llm,
      enableStreaming: false,
    });

    const messages: Message[] = [
      {
        role: "user",
        content: strategy.researchUserPrompt(topic, baseContext),
      },
    ];

    let finalText = "";
    let totalRounds = 0;

    // ── Tool-use loop ──────────────────────────────────────────
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      totalRounds = round;

      const response = await client.createMessage({
        systemPrompt: strategy.researchSystemPrompt(p.name),
        messages,
        tools,
      });

      const toolNames = (response.toolCalls ?? []).map((tc: ToolCall) => tc.toolName);
      const hasTools = response.toolCalls && response.toolCalls.length > 0;

      // Per-round log — always, regardless of tools or not
      logger.info("arena.research_round", {
        participant: p.name,
        round,
        toolCount: response.toolCalls?.length ?? 0,
        toolNames,
        textLen: response.text?.length ?? 0,
        stopReason: response.stopReason ?? "unknown",
      });

      if (!hasTools) {
        finalText = response.text;
        break;
      }

      // Report tool usage to UI
      onProgress?.({
        type: "context_lookup",
        participant: p.name,
        tools: response.toolCalls!.map((tc: ToolCall) => `${tc.toolName}(${JSON.stringify(tc.args)})`),
      });

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
      const resultBlocks: ContentBlock[] = response.toolCalls!.map((tc: ToolCall) => ({
        type: "tool_result" as const,
        tool_use_id: tc.id,
        content: executeContextTool(tc),
      }));
      messages.push({ role: "user", content: resultBlocks });
    }

    // ── Force-conclude if no text yet ──────────────────────────
    if (!finalText) {
      logger.warn("arena.research_force_conclude", {
        participant: p.name,
        totalRounds,
        messageCount: messages.length,
      });

      // Hard prompt: strip tools, demand immediate output
      const forceResponse = await client.createMessage({
        systemPrompt: strategy.researchSystemPrompt(p.name),
        messages: [
          ...messages,
          {
            role: "user",
            content:
              "You have gathered enough context. " +
              "Based on ALL the tool results above, output your findings NOW.\n\n" +
              "Respond ONLY with JSON — 3 to 6 highest-confidence findings. " +
              "Do NOT request any more tools. Do NOT apologize or explain. Just output the JSON.",
          },
        ],
        // No tools — forces text-only response
      });

      logger.info("arena.research_force_conclude_response", {
        participant: p.name,
        textLen: forceResponse.text?.length ?? 0,
        stopReason: forceResponse.stopReason ?? "unknown",
      });

      finalText = forceResponse.text;
    }

    // ── Final output ───────────────────────────────────────────
    logger.info("arena.research_raw_response", {
      participant: p.name,
      textLength: finalText.length,
      text: finalText,
    });

    // If still empty after force-conclude, mark as failed
    if (!finalText || finalText.trim().length === 0) {
      logger.warn("arena.research_failed", {
        participant: p.name,
        totalRounds,
        messageCount: messages.length,
      });

      const failedReport: ParticipantReport = {
        participant: p.name,
        contextSummary: `(research failed: model returned empty response after ${totalRounds} tool rounds)`,
        findings: [],
      };
      onProgress?.({ type: "research_done", participant: p.name, report: failedReport });
      return failedReport;
    }

    const report = strategy.parseResearchResponse(p.name, finalText);
    onProgress?.({ type: "research_done", participant: p.name, report });

    return report;
  });

  return Promise.all(tasks);
}
