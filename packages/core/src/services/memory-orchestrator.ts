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
import { extractJSON } from "../arena/strategies/utils.js";
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
  /**
   * Max memories to accept per extraction pass. From settings.memories.maxCount;
   * undefined → the built-in MAX_MEMORIES_PER_EXTRACTION default.
   */
  maxCount?: number;
  /**
   * From settings.memories.autoExtract. `false` skips step 1 (LLM memory
   * extraction) entirely — the user-curated store stops accumulating
   * extractor noise — while session summaries and auto-dream keep running.
   * Absent/true = extract (default behavior).
   */
  autoExtract?: boolean;
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
    // settings.memories.autoExtract=false skips the extractor entirely (the
    // curated store stops accumulating noise); summaries + dream still run.
    let extracted = 0;
    if (this.options.autoExtract === false) {
      logger.info("memory.extraction_skipped", { sessionId, reason: "autoExtract=false" });
    } else try {
      let t = Date.now();
      const existing = mm.loadAll();
      const loadMs = Date.now() - t;
      t = Date.now();
      const extractionPrompt = buildExtractionPrompt(transcript, existing);
      const promptMs = Date.now() - t;
      t = Date.now();
      const response = await this.options.callLLM(
        "You are a memory extraction assistant. Extract only durable, reusable information worth carrying into future sessions.",
        extractionPrompt,
      );
      const llmMs = Date.now() - t;
      t = Date.now();
      const entries = parseExtractionResponse(response, this.options.maxCount);
      const parseMs = Date.now() - t;
      t = Date.now();
      for (const entry of entries) {
        mm.save({
          type: entry.type,
          name: entry.name,
          description: entry.description,
          content: entry.content,
          // Provenance mark (feedback#18 方案 C): extractor writes are "auto"
          // so the UI can tell curated memories from extractor noise.
          origin: "auto",
        });
      }
      const saveMs = Date.now() - t;
      extracted = entries.length;
      logger.info("memory.extraction_done", {
        sessionId,
        extracted,
        elapsedMs: Date.now() - startTime,
        loadMs,
        promptMs,
        llmMs,
        parseMs,
        saveMs,
        existingCount: existing.length,
        transcriptMessages: transcript.length,
        responseChars: response.length,
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
        // LLM 摘要常带 markdown 围栏 / 围栏外解释文字 / 末尾逗号 → 裸 JSON.parse 易碎。
        // 复用 arena 的 extractJSON(剥围栏 + 花括号配平,识别字符串/转义)拿到候选,
        // 解析失败再修一次常见错误(末尾逗号),都不行才放弃(走 catch,该 session 无摘要)。
        const candidate = extractJSON(smResponse);
        let parsed: { summary?: unknown; keyTopics?: unknown; decisions?: unknown } | null = null;
        try {
          parsed = JSON.parse(candidate);
        } catch {
          try {
            parsed = JSON.parse(candidate.replace(/,(\s*[}\]])/g, "$1"));
          } catch {
            parsed = null;
          }
        }
        if (parsed) {
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
