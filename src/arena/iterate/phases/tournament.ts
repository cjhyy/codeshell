/**
 * Tournament v1 phase — every participant writes a candidate, then the
 * author merges anonymized candidates into v1.
 */

import { createLLMClient } from "../../../llm/client-factory.js";
import { logger } from "../../../logging/logger.js";
import type { ArenaParticipant } from "../../types.js";
import type { FormatPack } from "../formats/index.js";
import type { Draft, DraftCandidate, IterateConfig, IterateProgressEvent, IterateSubject } from "../types.js";
import { parseMergeResponse } from "../parse.js";

/** Run the v1 tournament: parallel candidate generation. */
export async function runTournamentCandidates(args: {
  subject: IterateSubject;
  format: FormatPack;
  participants: ArenaParticipant[];
  minDraftLength: number;
  signal?: AbortSignal;
  onProgress?: (e: IterateProgressEvent) => void;
}): Promise<DraftCandidate[]> {
  const { subject, format, participants, minDraftLength, signal, onProgress } = args;
  onProgress?.({ type: "v1_tournament_start", data: { count: participants.length } });

  const tasks = participants.map(async (p, idx) => {
    signal?.throwIfAborted();
    const client = await createLLMClient({ ...p.llm, enableStreaming: false });
    const prompt = format.draftPrompt(subject, minDraftLength);
    const resp = await client.createMessage({
      systemPrompt: prompt,
      messages: [{ role: "user", content: `Write your draft now.` }],
      tools: [],
      signal,
    });
    const content = resp.text.trim();
    const candidate: DraftCandidate = {
      author: p.name,
      anonymousLabel: `Draft ${String.fromCharCode(65 + idx)}`, // A, B, C...
      content,
    };
    onProgress?.({
      type: "v1_candidate_done",
      participant: p.name,
      data: { length: content.length, anonymousLabel: candidate.anonymousLabel },
    });
    logger.info("arena.iterate.v1_candidate", {
      participant: p.name,
      anonymousLabel: candidate.anonymousLabel,
      length: content.length,
    });
    return candidate;
  });

  // Tolerate individual failures — we'd rather merge fewer drafts than abort.
  const settled = await Promise.allSettled(tasks);
  const candidates: DraftCandidate[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") candidates.push(s.value);
    else logger.warn("arena.iterate.v1_candidate_failed", { error: s.reason?.message });
  }
  if (candidates.length === 0) {
    throw new Error("All v1 tournament candidates failed");
  }

  // Shuffle so anonymous labels don't correlate with participants[] order.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    candidates[i].anonymousLabel = `Draft ${String.fromCharCode(65 + i)}`;
  }
  candidates[0].anonymousLabel = `Draft A`;

  return candidates;
}

/** Merge candidates into v1 using the author. */
export async function mergeCandidatesToV1(args: {
  subject: IterateSubject;
  format: FormatPack;
  author: ArenaParticipant;
  candidates: DraftCandidate[];
  minDraftLength: number;
  signal?: AbortSignal;
  onProgress?: (e: IterateProgressEvent) => void;
}): Promise<Draft> {
  const { subject, format, author, candidates, minDraftLength, signal, onProgress } = args;
  onProgress?.({ type: "v1_merge_start", participant: author.name });

  const client = await createLLMClient({ ...author.llm, enableStreaming: false });
  const prompt = format.mergePrompt(subject, candidates, minDraftLength);
  const resp = await client.createMessage({
    systemPrompt: prompt,
    messages: [{ role: "user", content: `Produce v1 now.` }],
    tools: [],
    signal,
  });

  const { content, rationale } = parseMergeResponse(resp.text);
  const draft: Draft = {
    version: 1,
    author: author.name,
    format: format.format,
    content,
    draftCandidates: candidates,
    mergeRationale: rationale,
  };
  onProgress?.({ type: "v1_merge_done", participant: author.name, data: { length: content.length } });
  logger.info("arena.iterate.v1_merge", {
    author: author.name,
    candidateCount: candidates.length,
    length: content.length,
  });
  return draft;
}

/** Single-author v1 (tournament disabled) — author writes alone. */
export async function singleAuthorV1(args: {
  subject: IterateSubject;
  format: FormatPack;
  author: ArenaParticipant;
  minDraftLength: number;
  signal?: AbortSignal;
}): Promise<Draft> {
  const { subject, format, author, minDraftLength, signal } = args;
  const client = await createLLMClient({ ...author.llm, enableStreaming: false });
  const prompt = format.draftPrompt(subject, minDraftLength);
  const resp = await client.createMessage({
    systemPrompt: prompt,
    messages: [{ role: "user", content: `Write your draft now.` }],
    tools: [],
    signal,
  });
  return {
    version: 1,
    author: author.name,
    format: format.format,
    content: resp.text.trim(),
  };
}
