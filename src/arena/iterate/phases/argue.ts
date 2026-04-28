/**
 * Argue phase — critics read a draft and produce critiques in parallel.
 *
 * If `enableWebSearch` is on, each critic runs a tool-use loop and may call
 * web_search / web_fetch up to `maxArgueToolRounds` times before producing
 * the final critiques JSON. This is the deep-research path that catches
 * fabricated claims.
 */

import { createLLMClient } from "../../../llm/client-factory.js";
import { logger } from "../../../logging/logger.js";
import type { ArenaParticipant } from "../../types.js";
import type { Message, ToolCall } from "../../../types.js";
import type { FormatPack } from "../formats/index.js";
import type { Critique, Draft, IterateProgressEvent, IterateSubject } from "../types.js";
import { parseCritiquesResponse } from "../parse.js";
import { ITERATE_WEB_TOOLS, executeIterateWebTool, hasWebSearchProvider } from "../tools/web-tools.js";

const DEFAULT_MAX_TOOL_ROUNDS = 8;

export async function runArgueRound(args: {
  subject: IterateSubject;
  format: FormatPack;
  draft: Draft;
  critics: ArenaParticipant[];
  round: number;
  enableWebSearch?: boolean;
  maxToolRounds?: number;
  signal?: AbortSignal;
  onProgress?: (e: IterateProgressEvent) => void;
}): Promise<Critique[]> {
  const { subject, format, draft, critics, round, enableWebSearch, maxToolRounds, signal, onProgress } = args;
  onProgress?.({ type: "argue_start", round, data: { criticCount: critics.length } });

  // Web search is only useful if a provider is actually configured. Silently
  // downgrade if not — log a warning so the user knows.
  const wantWeb = Boolean(enableWebSearch);
  const webAvailable = wantWeb && hasWebSearchProvider();
  if (wantWeb && !webAvailable) {
    logger.warn("arena.iterate.argue_web_unavailable", {
      reason: "No SERPER_API_KEY / TAVILY_API_KEY / SEARXNG_URL configured",
    });
  }

  const idPrefix = `r${round}`;
  const tasks = critics.map(async (c) => {
    signal?.throwIfAborted();
    try {
      if (webAvailable) {
        return await argueWithToolLoop({
          critic: c,
          subject,
          format,
          draft,
          idPrefix,
          maxToolRounds: maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS,
          signal,
        });
      }
      return await argueSingleShot({ critic: c, subject, format, draft, idPrefix, signal });
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
    data: { critiqueCount: allCritiques.length, webEnabled: webAvailable },
  });
  return allCritiques;
}

// ─── Single-shot argue (no tools) ─────────────────────────────────────

async function argueSingleShot(args: {
  critic: ArenaParticipant;
  subject: IterateSubject;
  format: FormatPack;
  draft: Draft;
  idPrefix: string;
  signal?: AbortSignal;
}): Promise<Critique[]> {
  const { critic, subject, format, draft, idPrefix, signal } = args;
  const client = await createLLMClient({ ...critic.llm, enableStreaming: false });
  const resp = await client.createMessage({
    systemPrompt: format.argueSystem(format.format),
    messages: [{ role: "user", content: format.argueUser(subject, draft) }],
    tools: [],
    signal,
  });
  const critiques = parseCritiquesResponse(resp.text, critic.name, idPrefix);
  logger.info("arena.iterate.argue_singleshot", {
    critic: critic.name,
    critiqueCount: critiques.length,
  });
  return critiques;
}

// ─── Tool-use argue (with web search) ─────────────────────────────────

async function argueWithToolLoop(args: {
  critic: ArenaParticipant;
  subject: IterateSubject;
  format: FormatPack;
  draft: Draft;
  idPrefix: string;
  maxToolRounds: number;
  signal?: AbortSignal;
}): Promise<Critique[]> {
  const { critic, subject, format, draft, idPrefix, maxToolRounds, signal } = args;
  const client = await createLLMClient({ ...critic.llm, enableStreaming: false });

  const messages: Message[] = [
    { role: "user", content: format.argueUser(subject, draft) },
  ];

  let toolRounds = 0;
  let finalText = "";

  while (toolRounds < maxToolRounds) {
    signal?.throwIfAborted();
    const resp = await client.createMessage({
      systemPrompt: format.argueSystem(format.format),
      messages,
      tools: ITERATE_WEB_TOOLS,
      signal,
    });

    if (resp.text) finalText = resp.text;

    if (!resp.toolCalls || resp.toolCalls.length === 0) {
      // Done — final response with critiques JSON.
      break;
    }

    // Append assistant message with tool_use blocks
    messages.push({
      role: "assistant",
      content: [
        ...(resp.text ? [{ type: "text" as const, text: resp.text }] : []),
        ...resp.toolCalls.map((tc: ToolCall) => ({
          type: "tool_use" as const,
          id: tc.id,
          name: tc.toolName,
          input: tc.args,
        })),
      ],
    });

    // Execute tools and append tool_result blocks
    const toolResults = await Promise.all(
      resp.toolCalls.map(async (tc: ToolCall) => {
        try {
          const result = await executeIterateWebTool(tc.toolName, tc.args);
          return { id: tc.id, content: result };
        } catch (err) {
          return { id: tc.id, content: `Error: ${(err as Error).message}` };
        }
      }),
    );

    messages.push({
      role: "user",
      content: toolResults.map((tr) => ({
        type: "tool_result" as const,
        tool_use_id: tr.id,
        content: tr.content,
      })),
    });

    toolRounds++;
  }

  // If we ran out of rounds with no final text, prod the model once more.
  if (!finalText && toolRounds >= maxToolRounds) {
    const resp = await client.createMessage({
      systemPrompt: format.argueSystem(format.format),
      messages: [
        ...messages,
        {
          role: "user",
          content:
            "You have used the maximum number of tool rounds. Produce your " +
            "critiques JSON now, based on what you have already gathered. " +
            "Do not request any more tools.",
        },
      ],
      tools: [],
      signal,
    });
    finalText = resp.text;
  }

  const critiques = parseCritiquesResponse(finalText, critic.name, idPrefix);
  logger.info("arena.iterate.argue_toolloop", {
    critic: critic.name,
    critiqueCount: critiques.length,
    toolRounds,
  });
  return critiques;
}
