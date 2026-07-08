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

import {
  MemoryManager,
  type MemoryEntry,
  type MemoryOrigin,
  type MemoryScope,
} from "../session/memory.js";
import {
  buildExtractionPrompt,
  parseExtractionResponse,
  type ExistingMemorySummary,
  type ExtractedMemory,
} from "./extract-memories.js";
import { saveSessionMemory, buildSessionMemoryPrompt } from "./session-memory.js";
import { extractJSON } from "../utils/json.js";
import { redactSecrets } from "../logging/sanitize-messages.js";
import {
  shouldAutoDream,
  recordSession,
  recordDreamComplete,
  buildDreamSystemPrompt,
  buildDreamUserPrompt,
} from "./auto-dream.js";
import {
  applyGlobalDreamPromotionGate,
  detectUserDirectGlobalPreference,
} from "./global-dream-promotion.js";
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
  /**
   * Recall-based TTL in days (用户拍板 C). A `project`-type memory not read for
   * this many days is soft-deleted (moved to memory-trash). Stable types
   * (user/feedback/reference) and pinned entries are never pruned. From
   * settings.memories.recallTtlDays; undefined/<=0 → no sweep.
   */
  recallTtlDays?: number;
}

export interface MemoryOrchestratorResult {
  /** Number of new memory entries extracted and saved. */
  extracted: number;
  /** Whether the auto-dream consolidation was triggered. */
  dreamTriggered: boolean;
  /** Names of memories pruned by the recall-TTL sweep. */
  pruned: string[];
}

type MemoryLocation = "project" | "global";
type WriteAction = "ADD" | "UPDATE" | "DELETE" | "NOOP";

interface WriteDecision {
  action: WriteAction;
  target?: {
    id?: string;
    location: MemoryLocation;
    scope: "dream" | "user";
  };
  memory: ExtractedMemory;
  reason: string;
  guardedManual?: boolean;
}

interface MemoryCandidateSummary extends ExistingMemorySummary {
  entry: MemoryEntry;
  location: MemoryLocation;
  memoryScope: "user" | "dream";
  origin: MemoryOrigin;
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
    } else
      try {
        let t = Date.now();
        const existing = collectExistingMemorySummaries(mm, this.options.projectDir);
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
        let globalDreamCount = 0;
        let pendingGlobalCount = 0;
        let projectDreamCount = 0;
        let addCount = 0;
        let updateCount = 0;
        let noopCount = 0;
        let deleteCount = 0;
        let guardedManualCount = 0;
        const userDirectGlobal = detectUserDirectGlobalPreference(transcript);
        for (const entry of entries) {
          const redactedEntry: ExtractedMemory = {
            ...entry,
            description: redactSecrets(entry.description),
            content: redactSecrets(entry.content),
          };
          const decision = await decideWriteAction(redactedEntry, existing, this.options.callLLM);

          switch (decision.action) {
            case "ADD": {
              const isGlobal = redactedEntry.scope === "global";
              if (isGlobal) {
                const promotion = applyGlobalDreamPromotionGate({
                  projectDir: this.options.projectDir,
                  candidate: redactedEntry,
                  userDirectGlobal,
                });
                if (promotion.projectEvidenceSaved) projectDreamCount++;
                if (promotion.pendingSuggested) pendingGlobalCount++;
                if (promotion.promoted) globalDreamCount++;
                addCount++;
                break;
              }
              const target = memoryManagerForDecision("project", "dream", this.options.projectDir);
              target.save(
                {
                  type: redactedEntry.type,
                  name: redactedEntry.name,
                  description: redactedEntry.description,
                  content: redactedEntry.content,
                  origin: "auto",
                  ...(isGlobal && this.options.projectDir
                    ? { originProject: this.options.projectDir }
                    : {}),
                },
                { forceOrigin: "auto" },
              );
              if (isGlobal) globalDreamCount++;
              else projectDreamCount++;
              addCount++;
              break;
            }
            case "UPDATE": {
              const targetId = decision.target?.id;
              if (!targetId) {
                noopCount++;
                break;
              }
              const location = decision.target?.location ?? redactedEntry.scope;
              const target = memoryManagerForDecision(location, "dream", this.options.projectDir);
              const existingTarget = target.findById(targetId);
              if (!existingTarget || !target.isOwnedBy(existingTarget, ["auto", "dream"])) {
                noopCount++;
                guardedManualCount += existingTarget?.origin === "manual" ? 1 : 0;
                break;
              }
              target.save(
                {
                  id: targetId,
                  type: redactedEntry.type,
                  name: redactedEntry.name,
                  description: redactedEntry.description,
                  content: redactedEntry.content,
                  origin: existingTarget.origin ?? "auto",
                  pinned: existingTarget.pinned,
                  createdAt: existingTarget.createdAt,
                  useCount: existingTarget.useCount,
                  lastUsedAt: existingTarget.lastUsedAt,
                  originProject: existingTarget.originProject,
                },
                { forceOrigin: existingTarget.origin ?? "auto" },
              );
              if (location === "global") globalDreamCount++;
              else projectDreamCount++;
              updateCount++;
              break;
            }
            case "DELETE": {
              const targetId = decision.target?.id;
              const location = decision.target?.location ?? redactedEntry.scope;
              const target = memoryManagerForDecision(location, "dream", this.options.projectDir);
              if (!targetId) {
                noopCount++;
                break;
              }
              const deleteResult = target.deleteIfOwned(targetId, ["auto", "dream"]);
              if (deleteResult === "deleted") deleteCount++;
              else {
                noopCount++;
                if (deleteResult === "protected") guardedManualCount++;
              }
              break;
            }
            case "NOOP":
              noopCount++;
              if (decision.guardedManual) guardedManualCount++;
              break;
          }
        }
        const saveMs = Date.now() - t;
        extracted = entries.length;
        logger.info("memory.extraction_done", {
          sessionId,
          extracted,
          globalDreamCount,
          pendingGlobalCount,
          projectDreamCount,
          addCount,
          updateCount,
          noopCount,
          deleteCount,
          guardedManualCount,
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
        // 复用 utils/json 的 extractJSON(剥围栏 + 花括号配平,识别字符串/转义)拿到候选,
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
        // Dream sees project user/ (read-only context) + project dream/
        // (workspace) + global dream/ (cross-project workspace it also cleans).
        const userMems = mm.loadScope("user");
        const dreamMems = mm.loadScope("dream");
        const globalDreamMems = this.options.projectDir
          ? new MemoryManager({ scope: "dream" }).loadScope("dream")
          : [];
        if (userMems.length + dreamMems.length + globalDreamMems.length > 0) {
          const ran = await this.options.runDream({
            systemPrompt: buildDreamSystemPrompt(),
            userPrompt: buildDreamUserPrompt(userMems, dreamMems, globalDreamMems),
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

    // --------------- 5. Recall-based TTL sweep (用户拍板 C) ---------------
    // Soft-delete project-type memories not read for recallTtlDays. Runs on
    // both the project store and the global store (global also accumulates
    // project-type events if the LLM mis-scopes). Never throws into the result.
    const pruned: string[] = [];
    try {
      const ttl = this.options.recallTtlDays;
      if (ttl && ttl > 0) {
        pruned.push(...mm.pruneByRecall(ttl));
        // Only sweep the global store when we're not already it (projectDir set).
        if (this.options.projectDir) {
          pruned.push(...new MemoryManager({ scope: "user" }).pruneByRecall(ttl));
        }
        if (pruned.length > 0) {
          logger.info("memory.recall_ttl_pruned", { sessionId, pruned, ttlDays: ttl });
        }
      }
    } catch (err) {
      logger.warn("memory.recall_ttl_failed", {
        sessionId,
        error: (err as Error).message,
      });
    }

    return { extracted, dreamTriggered, pruned };
  }
}

function memoryManagerForDecision(
  location: MemoryLocation,
  scope: "user" | "dream",
  projectDir?: string,
): MemoryManager {
  return new MemoryManager({
    projectDir: location === "project" ? projectDir : undefined,
    scope,
  });
}

function collectExistingMemorySummaries(
  projectUserManager: MemoryManager,
  projectDir?: string,
): MemoryCandidateSummary[] {
  const seen = new Set<string>();
  const out: MemoryCandidateSummary[] = [];
  const add = (entries: MemoryEntry[], location: MemoryLocation, memoryScope: "user" | "dream") => {
    for (const entry of entries) {
      const key = `${location}:${memoryScope}:${entry.fileName}:${entry.id ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: entry.id,
        name: entry.name,
        type: entry.type,
        description: entry.description,
        location,
        memoryScope,
        origin: entry.origin ?? "manual",
        pinned: entry.pinned,
        useCount: entry.useCount,
        updateCount: entry.updateCount,
        updatedAt: entry.updatedAt,
        entry,
      });
    }
  };

  add(projectUserManager.loadScope("user"), "project", "user");
  add(memoryManagerForDecision("project", "dream", projectDir).loadAll(), "project", "dream");
  add(memoryManagerForDecision("global", "dream", projectDir).loadAll(), "global", "dream");
  add(memoryManagerForDecision("global", "user", projectDir).loadAll(), "global", "user");

  return out
    .sort((a, b) => {
      const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return bTime - aTime;
    })
    .slice(0, 120);
}

async function decideWriteAction(
  candidate: ExtractedMemory,
  existing: MemoryCandidateSummary[],
  callLLM: MemoryOrchestratorOptions["callLLM"],
): Promise<WriteDecision> {
  const fallback = fallbackWriteDecision(candidate, existing);
  const related = rankRelated(candidate, existing).slice(0, 40);
  const llmDecision = await askLLMForWriteDecision(
    candidate,
    related.map((r) => r.summary),
    callLLM,
  );
  if (!llmDecision) return fallback;

  const target = llmDecision.target?.id
    ? existing.find((m) => m.id === llmDecision.target?.id)
    : undefined;
  if ((llmDecision.action === "UPDATE" || llmDecision.action === "DELETE") && target) {
    if (target.origin === "manual") {
      return {
        action: "NOOP",
        memory: candidate,
        reason: "manual memory is protected",
        guardedManual: true,
      };
    }
    if (target.memoryScope === "dream" && (target.origin === "auto" || target.origin === "dream")) {
      return {
        ...llmDecision,
        memory: candidate,
        target: {
          id: target.id,
          location: target.location,
          scope: "dream",
        },
      };
    }
  }

  // Downgrade unsafe or duplicate ADDs using the deterministic guard.
  if (llmDecision.action === "ADD" && fallback.action !== "ADD") return fallback;
  if (llmDecision.action === "NOOP") return { ...llmDecision, memory: candidate };
  if (llmDecision.action === "ADD") return { ...llmDecision, memory: candidate };
  return fallback;
}

async function askLLMForWriteDecision(
  candidate: ExtractedMemory,
  related: MemoryCandidateSummary[],
  callLLM: MemoryOrchestratorOptions["callLLM"],
): Promise<WriteDecision | null> {
  if (related.length === 0) return null;
  try {
    const relatedText = related
      .map(
        (m) =>
          `- id:${m.id ?? "(none)"} location:${m.location} scope:${m.memoryScope} origin:${m.origin} ` +
          `[${m.type}] ${m.name}: ${m.description}`,
      )
      .join("\n");
    const response = await callLLM(
      "You are a memory write decision assistant. Output only one JSON object.",
      [
        "Decide whether this automatic memory candidate should ADD, UPDATE, NOOP, or DELETE.",
        "Manual memories are protected: if the target is origin:manual, choose NOOP.",
        "Automatic extraction writes new entries only to dream. Reuse an existing auto/dream dream id for same-topic updates.",
        "",
        "Candidate:",
        JSON.stringify(candidate),
        "",
        "Related existing memories:",
        relatedText,
        "",
        'Respond with JSON: {"action":"ADD|UPDATE|DELETE|NOOP","target":{"id":"...","location":"project|global","scope":"dream|user"},"reason":"short","confidence":"high|medium|low"}',
      ].join("\n"),
    );
    const parsed = JSON.parse(extractJSON(response));
    const action = typeof parsed.action === "string" ? parsed.action.toUpperCase() : "";
    if (!["ADD", "UPDATE", "DELETE", "NOOP"].includes(action)) return null;
    const location =
      parsed.target?.location === "global" || parsed.target?.location === "project"
        ? parsed.target.location
        : candidate.scope;
    const scope = parsed.target?.scope === "user" ? "user" : "dream";
    return {
      action: action as WriteAction,
      target: parsed.target?.id ? { id: String(parsed.target.id), location, scope } : undefined,
      memory: candidate,
      reason: typeof parsed.reason === "string" ? parsed.reason : "llm decision",
    };
  } catch {
    return null;
  }
}

function fallbackWriteDecision(
  candidate: ExtractedMemory,
  existing: MemoryCandidateSummary[],
): WriteDecision {
  const ranked = rankRelated(candidate, existing);
  const strong = ranked.filter((m) => m.score >= 0.55 || m.canonicalMatch);
  const manual = strong.find((m) => m.summary.origin === "manual");
  if (manual) {
    return {
      action: "NOOP",
      memory: candidate,
      reason: `same topic as manual memory ${manual.summary.id ?? manual.summary.name}`,
      guardedManual: true,
    };
  }

  const ownedDream = strong.find(
    (m) =>
      m.summary.location === candidate.scope &&
      m.summary.memoryScope === "dream" &&
      (m.summary.origin === "auto" || m.summary.origin === "dream") &&
      m.summary.id &&
      !m.summary.id.startsWith("legacy:"),
  );
  if (ownedDream?.summary.id) {
    return {
      action: "UPDATE",
      target: {
        id: ownedDream.summary.id,
        location: ownedDream.summary.location,
        scope: "dream",
      },
      memory: candidate,
      reason: `same topic as auto/dream memory ${ownedDream.summary.id}`,
    };
  }

  return { action: "ADD", memory: candidate, reason: "new automatic candidate" };
}

function rankRelated(
  candidate: ExtractedMemory,
  existing: MemoryCandidateSummary[],
): Array<{
  summary: MemoryCandidateSummary;
  score: number;
  canonicalMatch: boolean;
}> {
  const candidateText = `${candidate.name} ${candidate.description}`;
  const candidateKey = canonicalKey(candidateText);
  const candidateTokens = tokenSet(candidateText);
  return existing
    .map((summary) => {
      const existingText = `${summary.name} ${summary.description}`;
      const existingKey = canonicalKey(existingText);
      const existingTokens = tokenSet(existingText);
      return {
        summary,
        score: tokenOverlap(candidateTokens, existingTokens),
        canonicalMatch: candidateKey.length > 0 && candidateKey === existingKey,
      };
    })
    .sort((a, b) => {
      if (a.canonicalMatch !== b.canonicalMatch) return a.canonicalMatch ? -1 : 1;
      if (a.score !== b.score) return b.score - a.score;
      const aOwned = a.summary.origin === "auto" || a.summary.origin === "dream" ? 1 : 0;
      const bOwned = b.summary.origin === "auto" || b.summary.origin === "dream" ? 1 : 0;
      if (aOwned !== bOwned) return bOwned - aOwned;
      const aTime = a.summary.updatedAt ? new Date(a.summary.updatedAt).getTime() : 0;
      const bTime = b.summary.updatedAt ? new Date(b.summary.updatedAt).getTime() : 0;
      return bTime - aTime;
    });
}

function canonicalKey(text: string): string {
  return [...tokenSet(text)].sort().join(" ");
}

function tokenSet(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(/\b\d{8}\b/g, " ")
    .replace(/\b(today|yesterday|tomorrow|本轮|今天|昨天|明天)\b/g, " ")
    .replace(/\bv\d+\b/g, " ")
    .replace(/\b(batch|fix-batch)-\d+\b/g, " ")
    .replace(/\b[a-f0-9]{7,}\b/g, " ")
    .replace(/[\d]+/g, " ")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ");
  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "memory",
    "memories",
    "should",
    "must",
    "不要",
    "需要",
    "已经",
  ]);
  return new Set(
    normalized
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 2 && !stop.has(t)),
  );
}

function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared++;
  }
  return shared / Math.min(a.size, b.size);
}
