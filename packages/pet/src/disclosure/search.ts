/**
 * Bounded full-text grep over on-disk session transcripts. Candidates come
 * from listWorkSessionsOnDisk, so Pet/sub-agent/child/ephemeral sessions are
 * excluded for free. Reads whole transcript files (bounded by
 * MAX_FILE_BYTES) rather than the tail reader, since a match can be anywhere
 * in the conversation history, not just recent turns.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { listWorkSessionsOnDisk } from "./catalog.js";
import { textOfContent, type DiskTranscriptEvent } from "./jsonl.js";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const SNIPPET_RADIUS = 80;
const CONCURRENCY = 8;
const DEFAULT_MAX_SESSIONS = 20;
const DEFAULT_MAX_SNIPPETS_PER_SESSION = 3;
const DEFAULT_BUDGET_MS = 10_000;
const CANDIDATE_LIMIT = 500;

export interface SessionSearchSnippet {
  text: string;
  turnNumber: number;
}

export interface SessionSearchMatch {
  sessionId: string;
  title: string;
  cwd: string | null;
  updatedAt: number;
  snippets: SessionSearchSnippet[];
}

export interface SessionSearchResult {
  matches: SessionSearchMatch[];
  scannedSessions: number;
  truncated: boolean;
}

function buildSnippet(text: string, index: number, matchLength: number): string {
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + matchLength + SNIPPET_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

function findSnippetsInSession(
  events: DiskTranscriptEvent[],
  query: string,
  maxSnippets: number,
): SessionSearchSnippet[] {
  const snippets: SessionSearchSnippet[] = [];
  for (const event of events) {
    if (snippets.length >= maxSnippets) break;
    if (event.type !== "message") continue;
    const text = textOfContent(event.data?.content);
    if (!text) continue;
    const lowerText = text.toLowerCase();
    const index = lowerText.indexOf(query);
    if (index === -1) continue;
    snippets.push({
      text: buildSnippet(text, index, query.length),
      turnNumber: typeof event.turnNumber === "number" ? event.turnNumber : 0,
    });
  }
  return snippets;
}

export async function searchSessionTranscripts(
  sessionsRootDir: string,
  query: string,
  options: { maxSessions?: number; maxSnippetsPerSession?: number; budgetMs?: number },
): Promise<SessionSearchResult> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return { matches: [], scannedSessions: 0, truncated: false };
  }

  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxSnippetsPerSession = options.maxSnippetsPerSession ?? DEFAULT_MAX_SNIPPETS_PER_SESSION;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const deadline = Date.now() + budgetMs;

  const candidates = await listWorkSessionsOnDisk(sessionsRootDir, { limit: CANDIDATE_LIMIT });

  const matches: SessionSearchMatch[] = [];
  let scannedSessions = 0;
  let truncated = false;
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      if (Date.now() > deadline) {
        truncated = true;
        return;
      }
      if (matches.length >= maxSessions) {
        truncated = true;
        return;
      }
      const myIndex = cursor;
      cursor += 1;
      if (myIndex >= candidates.length) return;
      const candidate = candidates[myIndex]!;
      scannedSessions += 1;

      const transcriptPath = join(sessionsRootDir, candidate.sessionId, "transcript.jsonl");
      let size: number;
      try {
        size = (await stat(transcriptPath)).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES) {
        truncated = true;
        continue;
      }

      let text: string;
      try {
        text = await readFile(transcriptPath, "utf-8");
      } catch {
        continue;
      }

      const events: DiskTranscriptEvent[] = [];
      for (const rawLine of text.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as DiskTranscriptEvent;
          if (parsed && typeof parsed === "object") events.push(parsed);
        } catch {
          // skip malformed line
        }
      }

      const snippets = findSnippetsInSession(events, normalizedQuery, maxSnippetsPerSession);
      if (snippets.length > 0) {
        matches.push({
          sessionId: candidate.sessionId,
          title: candidate.title,
          cwd: candidate.cwd,
          updatedAt: candidate.updatedAt,
          snippets,
        });
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, () => worker());
  await Promise.all(workers);

  if (cursor < candidates.length) truncated = true;

  matches.sort((a, b) => b.updatedAt - a.updatedAt);
  return { matches: matches.slice(0, maxSessions), scannedSessions, truncated };
}
