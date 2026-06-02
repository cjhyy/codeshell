/**
 * Dream consolidation — the LLM tool-call loop that cleans up the `dream`
 * memory scope (deduplicate, merge, drop stale, improve descriptions).
 *
 * This logic used to live as two private methods on Engine
 * (`runDreamLoop` + `dispatchDreamTool`). It was extracted here so it can be
 * driven from two places:
 *   - the end-of-session auto-dream pipeline (Engine.runDreamLoop delegates here)
 *   - a manual "整理 / Dream" trigger from the desktop host, which constructs a
 *     seed Engine purely to obtain a toolRegistry + LLM client and then calls
 *     this directly (it never runs a turn).
 *
 * The loop is intentionally small and offline:
 *   - No streaming, no UI events — it runs in the background.
 *   - No permission prompts — there is no interactive backend on this path, so
 *     we hard-reject any attempt to Save/Delete in the "user" scope before
 *     dispatching. The "dream" scope is the LLM's workspace and goes through
 *     freely.
 *   - Capped at MAX_TURNS LLM round-trips and MAX_WRITES total mutations to
 *     bound damage on misbehavior.
 */

import type { LLMClientBase } from "../llm/client-base.js";
import type { ToolRegistry } from "../tool-system/registry.js";
import type { ToolContext } from "../tool-system/context.js";
import type { Message, ContentBlock, ToolCall } from "../types.js";
import { MemoryManager } from "../session/memory.js";
import {
  buildDreamSystemPrompt,
  buildDreamUserPrompt,
} from "./auto-dream.js";
import { logger } from "../logging/logger.js";

const MAX_TURNS = 8;
const MAX_WRITES = 10;
const MEMORY_TOOL_NAMES = ["MemoryList", "MemoryRead", "MemorySave", "MemoryDelete"];

export interface DreamConsolidationInput {
  /** LLM client for the consolidation calls. */
  llmClient: LLMClientBase;
  /** Tool registry that must contain the four Memory* tools. */
  toolRegistry: ToolRegistry;
  /**
   * Base tool context. `cwd` is overridden with `projectDir` (or process.cwd())
   * so the memory tools resolve the right memory directory. Callers with an
   * Engine pass `engine.buildToolContext()`.
   */
  toolContext: ToolContext;
  /** Project root; when set, memories are scoped per-project. */
  projectDir?: string;
  /** For log attribution. */
  sessionId?: string;
}

export interface DreamConsolidationResult {
  /** True if the loop ran (with or without writes); false if it bailed early. */
  ran: boolean;
  /** The LLM's final one-paragraph summary of what it changed (may be empty). */
  summary: string;
}

/**
 * Drive the dream-scope consolidation tool-call loop.
 *
 * Loads both scopes (user is read-only context; dream is the workspace),
 * builds the dream prompts, and runs the LLM with a whitelisted subset of
 * memory tools until it stops calling tools or hits the turn cap.
 *
 * Returns `ran: false` if the registry is missing the memory tools (nothing
 * happened); otherwise `ran: true` with the final summary text.
 */
export async function runDreamConsolidation(
  input: DreamConsolidationInput,
): Promise<DreamConsolidationResult> {
  const { llmClient, toolRegistry, projectDir, sessionId } = input;

  const memoryTools = MEMORY_TOOL_NAMES
    .map((n) => toolRegistry.getTool(n))
    .filter((t): t is NonNullable<typeof t> => t != null);
  if (memoryTools.length < MEMORY_TOOL_NAMES.length) {
    logger.warn("memory.dream_missing_tools", {
      sessionId,
      found: memoryTools.map((t) => t.name),
    });
    return { ran: false, summary: "" };
  }

  // Dream sees BOTH scopes — user/ is read-only context so it can spot
  // duplicates spanning scopes, dream/ is the workspace it edits.
  const mm = new MemoryManager({ projectDir });
  const userMems = mm.loadScope("user");
  const dreamMems = mm.loadScope("dream");

  const systemPrompt = buildDreamSystemPrompt();
  const userPrompt = buildDreamUserPrompt(userMems, dreamMems);

  // Strip RegisteredTool down to the shape createMessage expects.
  const toolDefs = memoryTools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));

  const toolCtx: ToolContext = {
    ...input.toolContext,
    cwd: projectDir ?? process.cwd(),
  };

  const messages: Message[] = [{ role: "user", content: userPrompt }];
  let writeBudget = MAX_WRITES;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await llmClient.createMessage({
      systemPrompt,
      messages,
      tools: toolDefs,
      maxTokens: 2048,
      recordUsage: false,
      reasoning: { mode: "off" },
    });

    if (resp.toolCalls.length === 0) {
      logger.info("memory.dream_finished", {
        sessionId,
        turn,
        finalText: resp.text.slice(0, 500),
      });
      return { ran: true, summary: resp.text };
    }

    // Echo the assistant turn back so subsequent turns see the tool_use ids.
    const assistantContent: ContentBlock[] = [];
    if (resp.text) assistantContent.push({ type: "text", text: resp.text });
    for (const tc of resp.toolCalls) {
      assistantContent.push({
        type: "tool_use",
        id: tc.id,
        name: tc.toolName,
        input: tc.args,
      });
    }
    messages.push({ role: "assistant", content: assistantContent });

    // Dispatch every tool call requested in this turn.
    const toolResults: ContentBlock[] = [];
    for (const tc of resp.toolCalls) {
      const result = await dispatchDreamTool(tc, toolRegistry, toolCtx, () => {
        if (writeBudget <= 0) return false;
        writeBudget--;
        return true;
      });
      toolResults.push({
        type: "tool_result",
        tool_use_id: tc.id,
        content: result,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  logger.warn("memory.dream_hit_turn_cap", { sessionId, maxTurns: MAX_TURNS });
  return { ran: true, summary: "" };
}

/**
 * Execute one memory tool call inside the dream loop. Enforces the two
 * dream-loop invariants the prompt also states:
 *   - Only the 4 memory tools are dispatchable.
 *   - Save/Delete in "user" scope is refused (returned as a tool error)
 *     because dream runs without an interactive permission backend.
 */
async function dispatchDreamTool(
  tc: ToolCall,
  toolRegistry: ToolRegistry,
  ctx: ToolContext,
  consumeWriteBudget: () => boolean,
): Promise<string> {
  const allowed = new Set(MEMORY_TOOL_NAMES);
  if (!allowed.has(tc.toolName)) {
    return `Error: tool "${tc.toolName}" is not available in the dream loop`;
  }

  const isWrite = tc.toolName === "MemorySave" || tc.toolName === "MemoryDelete";
  if (isWrite) {
    const scope = tc.args?.scope;
    if (scope !== "dream") {
      return (
        `Error: dream loop may only write to scope "dream", got "${scope}". ` +
        `User-scope changes require interactive permission, which is not available here.`
      );
    }
    if (!consumeWriteBudget()) {
      return "Error: dream write budget exhausted — stop calling write tools and summarize instead.";
    }
  }

  try {
    const result = await toolRegistry.executeTool(tc.toolName, tc.args, { ctx });
    if (result.isError) return result.error ?? `Error executing ${tc.toolName}`;
    return result.result ?? "";
  } catch (err) {
    return `Error executing ${tc.toolName}: ${(err as Error).message}`;
  }
}
