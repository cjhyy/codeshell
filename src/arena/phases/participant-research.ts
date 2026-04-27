/**
 * ParticipantResearch — each participant independently investigates
 * the shared base context and produces structured findings.
 *
 * Phase 3 upgrade: now captures ToolTrace and builds EvidencePackets,
 * outputting a full ResearchDossier alongside the ParticipantReport.
 */

import { createLLMClient } from "../../llm/client-factory.js";
import type { Message, ContentBlock, ToolCall } from "../../types.js";
import type {
  ArenaBaseContext,
  ArenaParticipant,
  ArenaStrategy,
  ArenaSourceKind,
  ParticipantReport,
  ResearchDossier,
  ToolTrace,
  EvidencePacket,
  FindingEvidenceLink,
  ArenaProgressEvent,
} from "../types.js";
import type { ToolDefinition } from "../../types.js";
import { CONTEXT_TOOLS, MAX_TOOL_ROUNDS, executeContextTool } from "../context/context-tools.js";
import { logger } from "../../logging/logger.js";
import { createHash } from "node:crypto";

/** Result of a single participant's research — includes both report and dossier */
export interface ResearchResult {
  report: ParticipantReport;
  dossier: ResearchDossier;
}

interface ResearchOptions {
  participants: ArenaParticipant[];
  strategy: ArenaStrategy;
  topic: string;
  baseContext: ArenaBaseContext;
  enableContextTools?: boolean;
  /** Plan-selected tools override. When provided, these are used instead of all CONTEXT_TOOLS. */
  contextTools?: ToolDefinition[];
  /** AbortSignal — cancels in-flight LLM calls */
  signal?: AbortSignal;
  onProgress?: (event: ArenaProgressEvent) => void;
}

/**
 * Run participant research phase in parallel.
 * Each participant reads the shared context, optionally requests more,
 * then produces structured findings with evidence trails.
 */
export async function runParticipantResearch(options: ResearchOptions): Promise<ParticipantReport[]> {
  const results = await runParticipantResearchWithDossiers(options);
  return results.map((r) => r.report);
}

/**
 * Run participant research phase with full dossier output.
 * Returns both reports (backward compat) and dossiers (evidence trail).
 */
export async function runParticipantResearchWithDossiers(options: ResearchOptions): Promise<ResearchResult[]> {
  const { participants, strategy, topic, baseContext, enableContextTools, contextTools, signal, onProgress } = options;
  const tools = enableContextTools ? (contextTools ?? CONTEXT_TOOLS) : undefined;

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
    const toolTraces: ToolTrace[] = [];
    const evidencePackets: EvidencePacket[] = [];

    // ── Tool-use loop ──────────────────────────────────────────
    const MAX_MESSAGES = 30; // Cap messages to prevent token overflow
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      totalRounds = round;

      // Safety: prevent unbounded message growth
      if (messages.length >= MAX_MESSAGES) {
        logger.warn("arena.research_message_limit", {
          participant: p.name,
          messageCount: messages.length,
          round,
        });
        break;
      }

      const response = await client.createMessage({
        systemPrompt: strategy.researchSystemPrompt(p.name),
        messages,
        tools,
        signal,
      });

      const toolNames = (response.toolCalls ?? []).map((tc: ToolCall) => tc.toolName);
      const hasTools = response.toolCalls && response.toolCalls.length > 0;

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

      // Execute tools, record traces, and build evidence packets
      const resultBlocks: ContentBlock[] = [];
      for (const tc of response.toolCalls!) {
        const result = executeContextTool(tc);

        // Record tool trace
        const trace: ToolTrace = {
          round,
          toolName: tc.toolName,
          args: tc.args,
          resultRef: buildResultRef(tc),
          keptAsEvidence: result.length > 50 && !result.startsWith("Error:") && !result.startsWith("Tool error:") && !result.startsWith("Unknown tool:"),
        };
        toolTraces.push(trace);

        // Build evidence packet from successful tool results
        if (trace.keptAsEvidence) {
          const packet = buildEvidencePacketFromTool(p.name, tc, result, inferSourceKind(tc.toolName));
          evidencePackets.push(packet);
        }

        resultBlocks.push({
          type: "tool_result" as const,
          tool_use_id: tc.id,
          content: result,
        });
      }
      messages.push({ role: "user", content: resultBlocks });
    }

    // ── Force-conclude if no text yet ──────────────────────────
    if (!finalText) {
      logger.warn("arena.research_force_conclude", {
        participant: p.name,
        totalRounds,
        messageCount: messages.length,
      });

      const forceResponse = await client.createMessage({
        systemPrompt: strategy.researchSystemPrompt(p.name),
        messages: [
          ...messages,
          {
            role: "user",
            content:
              "You have gathered enough context. " +
              "Based on ALL the tool results above, output your findings NOW.\n\n" +
              "Respond ONLY with JSON — output your highest-confidence findings " +
              "(typically 5-15 for a substantive topic; each finding's `summary` " +
              "should be 80+ words with concrete evidence). " +
              "Do NOT request any more tools. Just output the JSON.",
          },
        ],
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
      const failedDossier: ResearchDossier = {
        participant: p.name,
        contextSummary: failedReport.contextSummary,
        findings: [],
        toolTrace: toolTraces,
        evidencePackets,
        findingEvidenceLinks: [],
      };
      onProgress?.({ type: "research_done", participant: p.name, report: failedReport });
      return { report: failedReport, dossier: failedDossier };
    }

    const report = strategy.parseResearchResponse(p.name, finalText);

    // Build finding-evidence links by matching finding evidence refs to packets
    const findingEvidenceLinks = buildFindingEvidenceLinks(report, evidencePackets);

    const dossier: ResearchDossier = {
      participant: p.name,
      contextSummary: report.contextSummary,
      findings: report.findings,
      toolTrace: toolTraces,
      evidencePackets,
      findingEvidenceLinks,
    };

    onProgress?.({ type: "research_done", participant: p.name, report });

    return { report, dossier };
  });

  return Promise.all(tasks);
}

// ─── Helper functions ──────────────────────────────────────────

/** Build a stable ref string for a tool call */
function buildResultRef(tc: ToolCall): string {
  if (tc.toolName === "read_file" && tc.args.path) return `file:${tc.args.path}`;
  if (tc.toolName === "grep_code" && tc.args.pattern) return `grep:${tc.args.pattern}`;
  if (tc.toolName === "list_files" && tc.args.path) return `dir:${tc.args.path}`;
  if (tc.toolName === "git_show" && tc.args.ref) return `git:${tc.args.ref}`;
  if (tc.toolName === "git_blame" && tc.args.path) return `blame:${tc.args.path}`;
  return `${tc.toolName}:${JSON.stringify(tc.args).slice(0, 60)}`;
}

/** Generate a stable packet ID */
function generatePacketId(participant: string, source: string, ref: string, snippet: string): string {
  const hash = createHash("sha256")
    .update(`${participant}:${source}:${ref}:${snippet.slice(0, 200)}`)
    .digest("hex")
    .slice(0, 12);
  return `pkt-${hash}`;
}

/** Infer the evidence source kind from the tool that produced it */
function inferSourceKind(toolName: string): ArenaSourceKind {
  switch (toolName) {
    case "git_show":
    case "git_blame":
      return "git";
    case "read_file":
    case "grep_code":
    case "list_files":
      return "repo";
    default:
      return "repo";
  }
}

/** Build an EvidencePacket from a tool call result */
function buildEvidencePacketFromTool(
  participant: string,
  tc: ToolCall,
  result: string,
  source: ArenaSourceKind,
): EvidencePacket {
  const ref = buildResultRef(tc);
  const snippet = result.slice(0, 500);
  const packetId = generatePacketId(participant, source, ref, snippet);

  return {
    packetId,
    participant,
    source,
    title: `${tc.toolName}: ${formatToolArgs(tc.args)}`,
    refs: [ref],
    summary: result.slice(0, 200),
    excerpts: [{
      ref,
      snippet,
      note: `Result of ${tc.toolName} call`,
    }],
  };
}

/** Format tool args into a concise display string */
function formatToolArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") parts.push(value.slice(0, 60));
    else parts.push(`${key}=${JSON.stringify(value)}`);
  }
  return parts.join(", ").slice(0, 100);
}

/**
 * Build links between findings and evidence packets by matching
 * finding evidence refs against packet refs.
 */
function buildFindingEvidenceLinks(
  report: ParticipantReport,
  packets: EvidencePacket[],
): FindingEvidenceLink[] {
  const links: FindingEvidenceLink[] = [];

  for (const finding of report.findings) {
    const matchedPacketIds: string[] = [];

    for (const evidence of finding.evidence) {
      const evidenceRef = `${evidence.type}:${evidence.ref}`;

      // Find packets whose refs overlap with this evidence ref
      for (const packet of packets) {
        const matches = packet.refs.some((pRef) => {
          // Exact match
          if (pRef === evidenceRef) return true;
          // Partial match — packet ref contains the file path
          if (evidence.ref && pRef.includes(evidence.ref)) return true;
          return false;
        });

        if (matches && !matchedPacketIds.includes(packet.packetId)) {
          matchedPacketIds.push(packet.packetId);
        }
      }
    }

    if (matchedPacketIds.length > 0) {
      links.push({
        findingId: finding.id,
        evidencePacketIds: matchedPacketIds,
      });
    }
  }

  return links;
}
