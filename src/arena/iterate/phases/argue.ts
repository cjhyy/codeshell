/**
 * Argue phase — critics read a draft and produce critiques in parallel.
 */

import { createLLMClient } from "../../../llm/client-factory.js";
import { logger } from "../../../logging/logger.js";
import type { ArenaParticipant } from "../../types.js";
import type { FormatPack } from "../formats/index.js";
import type { Critique, Draft, IterateProgressEvent, IterateSubject } from "../types.js";
import { parseCritiquesResponse } from "../parse.js";

export async function runArgueRound(args: {
  subject: IterateSubject;
  format: FormatPack;
  draft: Draft;
  critics: ArenaParticipant[];
  round: number;
  signal?: AbortSignal;
  onProgress?: (e: IterateProgressEvent) => void;
}): Promise<Critique[]> {
  const { subject, format, draft, critics, round, signal, onProgress } = args;
  onProgress?.({ type: "argue_start", round, data: { criticCount: critics.length } });

  const idPrefix = `r${round}`;
  const tasks = critics.map(async (c) => {
    signal?.throwIfAborted();
    try {
      const client = await createLLMClient({ ...c.llm, enableStreaming: false });
      const resp = await client.createMessage({
        systemPrompt: format.argueSystem(format.format),
        messages: [{ role: "user", content: format.argueUser(subject, draft) }],
        tools: [],
        signal,
      });
      const critiques = parseCritiquesResponse(resp.text, c.name, idPrefix);
      logger.info("arena.iterate.argue", {
        round,
        critic: c.name,
        critiqueCount: critiques.length,
      });
      return critiques;
    } catch (err) {
      logger.warn("arena.iterate.argue_failed", {
        round,
        critic: c.name,
        error: (err as Error).message,
      });
      return [];
    }
  });

  const results = await Promise.all(tasks);
  const allCritiques = results.flat();
  onProgress?.({
    type: "argue_done",
    round,
    data: { critiqueCount: allCritiques.length },
  });
  return allCritiques;
}
