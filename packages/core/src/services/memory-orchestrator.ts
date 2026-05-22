/**
 * MemoryOrchestrator — ties extract-memories, session-memory, and auto-dream
 * into a single end-of-session pipeline.
 *
 * Called by Engine.run() after the turn loop completes. Runs memory extraction
 * and session summarisation via lightweight LLM calls, then conditionally
 * triggers auto-dream consolidation. None of this blocks the Engine result.
 *
 * Dream uses a tool-call loop (not free-text JSON output) so the LLM can
 * incrementally inspect and modify the dream-scope workspace via the same
 * MemoryList/Read/Save/Delete tools the user-facing assistant has access to.
 * The caller supplies `runDream`, which owns the LLM client and tool registry
 * — orchestrator just decides WHEN to trigger.
 */

import { MemoryManager } from "../session/memory.js";
import { buildExtractionPrompt, parseExtractionResponse } from "./extract-memories.js";
import { saveSessionMemory, buildSessionMemoryPrompt } from "./session-memory.js";
import { shouldAutoDream, recordSession, recordDreamComplete, buildDreamSystemPrompt, buildDreamUserPrompt } from "./auto-dream.js";
import { logger } from "../logging/logger.js";

export interface MemoryOrchestratorOptions {
  /** Lightweight LLM call — must be a non-streaming summarisation call. */
  callLLM: (systemPrompt: string, userMsg: string) => Promise<string>;
  /**
   * Auto-dream consolidation driver. Called when the dream cadence is due
   * (every N sessions, no more than once per 24h). Returns true if the dream
   * actually executed (so the orchestrator can record the timestamp); false
   * if the caller decided to skip (e.g. no memories to consolidate, headless
   * mode without LLM client, etc.).
   *
   * Implementation lives in Engine because it needs the LLM client and the
   * memory tool implementations — both of which are orchestrator-agnostic.
   */
  runDream?: (input: {
    systemPrompt: string;
    userPrompt: string;
    projectDir?: string;
  }) => Promise<boolean>;
  /** Project root; when set, memories are scoped per-project. */
  projectDir?: string;
  /** Optional pre-constructed MemoryManager (avoids re-creating for every call). */
  memoryManager?: MemoryManager;
}

export interface MemoryOrchestratorResult {
  /** Number of new memory entries extracted and saved. */
  extracted: number;
  /** Whether the auto-dream consolidation was triggered. */
  dreamTriggered: boolean;
}

export class MemoryOrchestrator {
  constructor(private readonly options: MemoryOrchestratorOptions) {}

  /**
   * Run the full end-of-session memory pipeline.
   *
   *  1. Extract durable memories from the transcript (extract-memories)
   *  2. Summarise the session (session-memory)
   *  3. Record a completed session for auto-dream tracking
   *  4. Conditionally trigger auto-dream consolidation
   */
  async run(
    transcript: Array<{ role: string; content: string }>,
    sessionId: string,
  ): Promise<MemoryOrchestratorResult> {
    const mm =
      this.options.memoryManager ?? new MemoryManager({ projectDir: this.options.projectDir });
    const startTime = Date.now();

    // --------------- 1. Extract durable memories ---------------
    let extracted = 0;
    try {
      const existing = mm.loadAll();
      const extractionPrompt = buildExtractionPrompt(transcript, existing);
      const response = await this.options.callLLM(
        "You are a memory extraction assistant. Extract only durable, reusable information worth carrying into future sessions.",
        extractionPrompt,
      );
      const entries = parseExtractionResponse(response);
      for (const entry of entries) {
        mm.save({
          type: entry.type,
          name: entry.name,
          description: entry.description,
          content: entry.content,
        });
      }
      extracted = entries.length;
      logger.info("memory.extraction_done", {
        sessionId,
        extracted,
        elapsedMs: Date.now() - startTime,
      });
    } catch (err) {
      logger.warn("memory.extraction_failed", {
        sessionId,
        error: (err as Error).message,
      });
    }

    // --------------- 2. Session summary ---------------
    try {
      // Only summarise sessions with enough content to be meaningful.
      const messageCount = transcript.filter((m) => m.role !== "system").length;
      if (messageCount >= 3) {
        const smPrompt = buildSessionMemoryPrompt(transcript);
        const smResponse = await this.options.callLLM(
          "You are a session summariser. Output only valid JSON.",
          smPrompt,
        );
        const jsonMatch = smResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          saveSessionMemory({
            sessionId,
            summary: String(parsed.summary ?? "").slice(0, 1000),
            keyTopics: Array.isArray(parsed.keyTopics) ? parsed.keyTopics.slice(0, 20) : [],
            decisions: Array.isArray(parsed.decisions) ? parsed.decisions.slice(0, 20) : [],
            createdAt: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      logger.warn("memory.session_memory_failed", {
        sessionId,
        error: (err as Error).message,
      });
    }

    // --------------- 3. Record session for auto-dream tracking ---------------
    recordSession();

    // --------------- 4. Auto-dream consolidation ---------------
    // Drives a tool-call loop in the caller (Engine.runDream) so the LLM can
    // list/read/save/delete dream-scope memories via the same Memory* tools
    // the user-facing assistant uses. Skipped when:
    //   - the cadence isn't due yet (shouldAutoDream returns false)
    //   - the caller didn't wire a runDream driver (e.g. headless tests)
    //   - the workspace is empty (nothing to consolidate)
    let dreamTriggered = false;
    try {
      if (shouldAutoDream() && this.options.runDream) {
        // Dream sees BOTH scopes — user/ is read-only context so it can spot
        // duplicates spanning scopes, dream/ is the workspace it edits.
        const userMems = mm.loadScope("user");
        const dreamMems = mm.loadScope("dream");
        if (userMems.length + dreamMems.length > 0) {
          const ran = await this.options.runDream({
            systemPrompt: buildDreamSystemPrompt(),
            userPrompt: buildDreamUserPrompt(userMems, dreamMems),
            projectDir: this.options.projectDir,
          });
          if (ran) {
            recordDreamComplete();
            dreamTriggered = true;
            logger.info("memory.auto_dream_done", {
              sessionId,
              userMemoryCount: userMems.length,
              dreamMemoryCount: dreamMems.length,
              elapsedMs: Date.now() - startTime,
            });
          }
        }
      }
    } catch (err) {
      logger.warn("memory.auto_dream_failed", {
        sessionId,
        error: (err as Error).message,
      });
    }

    return { extracted, dreamTriggered };
  }
}
