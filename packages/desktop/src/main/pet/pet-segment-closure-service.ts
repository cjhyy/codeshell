/**
 * pet-segment-closure-service — distill a just-closed Mimi topic segment.
 *
 * When a long-idle boundary closes a topic segment, this service turns that
 * segment's slice of the Mimi conversation into ONE journal entry (title +
 * summary) plus up to two durable memory candidates, then hands the caller the
 * transcript range so the model context can be archived. It is the single
 * aux-model touch point for the "event archive" + auto-memory feature.
 *
 * The LLM plumbing mirrors pet-summary-service: read settings fresh, resolve the
 * aux text model (falling back to defaults.text via resolveLLMConfigForTag),
 * build a one-shot client, and make a single tool-less createMessage call. All
 * heavy lifting (window location, prompt build, response parse) is delegated to
 * the pure primitives in @cjhyy/code-shell-pet so this file stays effect-only.
 */
import {
  SettingsManager,
  createLLMClient,
  resolveAuxKey,
  resolveLLMConfigForTag,
} from "@cjhyy/code-shell-core";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  MIN_CLOSURE_MESSAGES,
  SEGMENT_CLOSURE_SYSTEM_PROMPT,
  buildClosureInput,
  locateClosureWindow,
  parseClosureResponse,
  type ClosureExtraction,
  type ClosureMessage,
} from "@cjhyy/code-shell-pet";
import type { PetJournalStore } from "./pet-journal-store.js";
import type { PetMemoryStore } from "./pet-memory-store.js";
import { dlog } from "../desktop-logger.js";

export interface SegmentClosureInput {
  /** The segment that just closed (source of the journal entry + memory backlink). */
  segmentId: string;
  /** Client-message-id the closed segment began at; undefined ⇒ window starts at 0. */
  closingBoundaryMessageId?: string;
  /** Client-message-id of the newly opened segment (exclusive end); undefined ⇒ end. */
  nextBoundaryMessageId?: string;
  startedAt: number;
  endedAt: number;
}

export interface SegmentClosureResult {
  range: { start: number; end: number };
}

/** Redact obvious secrets before the slice is sent to the aux model. */
function sanitize(text: string): string {
  return text
    .replace(/\b(?:sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9]{16,}\b/g, "[secret]")
    .replace(/\b[A-Za-z0-9]{32,}\b/g, (match) => (/^\d+$/.test(match) ? match : "[secret]"));
}

/** Read the pet transcript's ordered user/assistant messages for range math. */
async function defaultReadMessages(transcriptPath: string): Promise<ClosureMessage[]> {
  let text: string;
  try {
    text = await readFile(transcriptPath, "utf-8");
  } catch {
    return [];
  }
  const messages: ClosureMessage[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let event: { type?: string; data?: Record<string, unknown> };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (event.type !== "message") continue;
    const data = event.data ?? {};
    const role = data.role;
    if (role !== "user" && role !== "assistant") continue;
    // Injected synthetic user turns (background-job notifications) are not real
    // conversation and must not shift indices relative to Engine.toMessages.
    if (role === "user" && data.injected === true) continue;
    messages.push({
      role,
      text: contentText(data.content),
      ...(typeof data.clientMessageId === "string"
        ? { clientMessageId: data.clientMessageId }
        : {}),
    });
  }
  return messages;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: "text"; text: string } =>
          Boolean(block) &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text)
      .join("");
  }
  return "";
}

function createDefaultGenerate(cwd: string): (input: string) => Promise<ClosureExtraction | null> {
  return async (input: string): Promise<ClosureExtraction | null> => {
    const settings = new SettingsManager(cwd, "full").get();
    const auxId = resolveAuxKey(settings);
    const resolved = resolveLLMConfigForTag(settings, "text", auxId);
    if (!resolved) {
      dlog("main", "pet.closure.no-model", {});
      return null;
    }
    const client = await createLLMClient(resolved);
    const response = await client.createMessage({
      systemPrompt: SEGMENT_CLOSURE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: input }],
      tools: [],
      reasoning: { mode: "off" },
      requestVisible: false,
      maxTokens: 512,
    });
    return parseClosureResponse(response.text ?? "");
  };
}

/** A closed segment as seen by the startup backfill (id + first-turn message id). */
export interface ClosedSegmentDescriptor {
  id: string;
  boundaryBeforeMessageId?: string;
  startedAt: number;
}

export interface PetSegmentClosureService {
  /**
   * Distill and persist the closed segment. Returns the transcript range so the
   * caller can archive it, or null when nothing was written (too short, no
   * model, parse/aux failure) — the caller then skips archival.
   */
  close(input: SegmentClosureInput): Promise<SegmentClosureResult | null>;

  /**
   * Startup compensation: close any settled segment (every segment except the
   * active last one) that has no journal entry yet, so a segment whose
   * fire-and-forget closure was interrupted by app exit still gets recorded.
   * `now` stamps the endedAt of segments that never captured one.
   */
  backfill(segments: readonly ClosedSegmentDescriptor[], now: number): Promise<void>;

  /**
   * Read-only原文 for the UI: the pet transcript's ordered messages in a
   * message-index window (a journal entry's `range`). Role + text only — the
   * viewer does not replay the full fold pipeline.
   */
  readSegmentMessages(range: {
    start: number;
    end: number;
  }): Promise<Array<{ role: "user" | "assistant"; text: string }>>;
}

export function createPetSegmentClosureService(deps: {
  petSessionId: string;
  sessionsRootDir: string;
  journal: PetJournalStore;
  memory: PetMemoryStore;
  /** Whether auto-extraction is enabled; when false, journal + memory are skipped. */
  autoExtractEnabled: () => boolean;
  cwd?: string;
  /** Injectable transcript reader (defaults to reading the pet transcript file). */
  readMessages?: (transcriptPath: string) => Promise<ClosureMessage[]>;
  /** Injectable aux call (defaults to a real one-shot aux client). */
  generate?: (input: string) => Promise<ClosureExtraction | null>;
}): PetSegmentClosureService {
  const readMessages = deps.readMessages ?? defaultReadMessages;
  const generate = deps.generate ?? createDefaultGenerate(deps.cwd ?? process.cwd());
  const transcriptPath = join(deps.sessionsRootDir, deps.petSessionId, "transcript.jsonl");

  return {
    async close(input) {
      let messages: ClosureMessage[];
      try {
        messages = await readMessages(transcriptPath);
      } catch (error) {
        dlog("main", "pet.closure.read.failed", { error: String(error) });
        return null;
      }
      const window = locateClosureWindow(
        messages,
        input.closingBoundaryMessageId,
        input.nextBoundaryMessageId,
      );
      if (!window) return null;
      const meaningful = window.messages.filter((message) => message.text.trim().length > 0);
      if (meaningful.length < MIN_CLOSURE_MESSAGES) return null;

      // Extraction (journal + memory) is gated by the preference; context
      // archival is not — the caller still archives the returned range so a
      // disabled toggle cannot let the model context grow without bound.
      if (deps.autoExtractEnabled()) {
        const promptInput = sanitize(buildClosureInput(window.messages));
        let extraction: ClosureExtraction | null = null;
        try {
          extraction = await generate(promptInput);
        } catch (error) {
          dlog("main", "pet.closure.generate.failed", { error: String(error) });
        }
        if (extraction) {
          try {
            await deps.journal.record({
              segmentId: input.segmentId,
              title: extraction.title,
              summary: extraction.summary,
              startedAt: input.startedAt,
              endedAt: input.endedAt,
              messageCount: meaningful.length,
              range: window.range,
            });
          } catch (error) {
            dlog("main", "pet.closure.journal.failed", { error: String(error) });
          }
          for (const text of extraction.memories) {
            try {
              await deps.memory.remember(text, "auto", { segmentId: input.segmentId });
            } catch (error) {
              // A full user-only library or invalid text is non-fatal: keep the
              // journal entry already written and drop the rejected candidate.
              dlog("main", "pet.closure.memory.failed", { error: String(error) });
            }
          }
        }
      }

      return { range: window.range };
    },

    async backfill(segments, now) {
      // Every segment except the active (last) one has settled. Skip those the
      // journal already recorded; the last segment stays open until its own
      // boundary closes it.
      if (segments.length <= 1) return;
      await deps.journal.load().catch(() => undefined);
      const recorded = deps.journal.recordedSegmentIds();
      const settled = segments.slice(0, -1);
      for (let index = 0; index < settled.length; index += 1) {
        const segment = settled[index]!;
        if (recorded.has(segment.id)) continue;
        const next = segments[index + 1];
        try {
          const result = await this.close({
            segmentId: segment.id,
            ...(segment.boundaryBeforeMessageId
              ? { closingBoundaryMessageId: segment.boundaryBeforeMessageId }
              : {}),
            ...(next?.boundaryBeforeMessageId
              ? { nextBoundaryMessageId: next.boundaryBeforeMessageId }
              : {}),
            startedAt: segment.startedAt,
            endedAt: next?.startedAt ?? now,
          });
          // Backfill does NOT archive: the range may already have been archived
          // in the previous run, and re-archiving a shifted window would corrupt
          // live context. It only recovers the missing journal + memory record.
          void result;
        } catch (error) {
          dlog("main", "pet.closure.backfill.failed", {
            error: String(error),
            segment: segment.id,
          });
        }
      }
    },

    async readSegmentMessages(range) {
      let messages: ClosureMessage[];
      try {
        messages = await readMessages(transcriptPath);
      } catch (error) {
        dlog("main", "pet.closure.read.failed", { error: String(error) });
        return [];
      }
      const start = Math.max(0, range.start);
      const end = Math.min(messages.length, range.end);
      if (end <= start) return [];
      return messages
        .slice(start, end)
        .map((message) => ({ role: message.role, text: message.text }));
    },
  };
}
