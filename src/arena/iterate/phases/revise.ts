/**
 * Revise phase — author rewrites the draft addressing critiques.
 */

import { createLLMClient } from "../../../llm/client-factory.js";
import { logger } from "../../../logging/logger.js";
import type { ArenaParticipant } from "../../types.js";
import type { FormatPack } from "../formats/index.js";
import type { Critique, Draft, IterateProgressEvent, IterateSubject } from "../types.js";
import { parseReviseResponse } from "../parse.js";

export async function runRevise(args: {
  subject: IterateSubject;
  format: FormatPack;
  previous: Draft;
  critiques: Critique[];
  author: ArenaParticipant;
  minDraftLength: number;
  signal?: AbortSignal;
  onProgress?: (e: IterateProgressEvent) => void;
}): Promise<Draft> {
  const { subject, format, previous, critiques, author, minDraftLength, signal, onProgress } = args;
  onProgress?.({ type: "revise_start", round: previous.version + 1, participant: author.name });

  const client = await createLLMClient({ ...author.llm, enableStreaming: false });
  const prompt = format.revisePrompt(subject, previous, critiques, minDraftLength);
  const resp = await client.createMessage({
    systemPrompt: prompt,
    messages: [{ role: "user", content: `Produce v${previous.version + 1} now.` }],
    tools: [],
    signal,
  });

  const { content, meta } = parseReviseResponse(resp.text);

  // Defensive: refuse to accept a revision that's drastically shorter than v(N) — that's
  // usually the model collapsing into a summary rather than rewriting.
  // Accept if shrinkage < 30% OR new content is still above the minimum length.
  let acceptedContent = content;
  const shrinkage = previous.content.length > 0
    ? 1 - acceptedContent.length / previous.content.length
    : 0;
  if (shrinkage > 0.3 && acceptedContent.length < minDraftLength) {
    logger.warn("arena.iterate.revise_too_short", {
      version: previous.version + 1,
      previousLength: previous.content.length,
      newLength: acceptedContent.length,
      minDraftLength,
    });
    // Don't retry automatically — keep going but flag in changelog.
    meta.changelog =
      `[WARNING: revision is ${Math.round(shrinkage * 100)}% shorter than v${previous.version}; the author may have summarized instead of rewriting]\n\n` +
      (meta.changelog ?? "");
  }

  const next: Draft = {
    version: previous.version + 1,
    author: author.name,
    format: format.format,
    content: acceptedContent,
    acceptedCritiques: meta.acceptedCritiques,
    rejectedCritiques: meta.rejectedCritiques,
    changelog: meta.changelog,
  };

  onProgress?.({
    type: "revise_done",
    round: next.version,
    participant: author.name,
    data: { length: acceptedContent.length, accepted: meta.acceptedCritiques?.length ?? 0 },
  });

  logger.info("arena.iterate.revise", {
    version: next.version,
    author: author.name,
    length: acceptedContent.length,
    accepted: meta.acceptedCritiques?.length ?? 0,
    rejected: meta.rejectedCritiques?.length ?? 0,
  });

  return next;
}
