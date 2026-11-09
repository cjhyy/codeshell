/**
 * Rolling summary of a selected context package on the auxiliary model:
 * every complete API round (or lossless fragment) feeds the same nine-section
 * merge, one aux-window-sized batch per request. The Engine resolves the
 * client, billing owner and trace scope; this module owns the request shape
 * and the window loop.
 */
import {
  CONTEXT_PACKAGE_MAX_OUTPUT_TOKENS,
  buildContextPackagePromptFromSerialized,
  contextPackageRequestFits,
  estimateTokens,
  groupMessagesByApiRound,
  serializeContextPackageMessages,
  takeContextPackageWindow,
} from "../context/compaction.js";
import type { Message, TokenUsage } from "../types.js";
import type { ResolvedAuxClient } from "./auxiliary-pipeline.js";

const SYSTEM_PROMPT =
  "You package selected conversation context. Be concise, factual, and complete.";

/** Reject packages that have nothing a text summary could carry. */
export function assertSummarizableContextPackage(messages: Message[]): void {
  if (messages.length === 0) throw new Error("Cannot summarize an empty context package");
  if (!serializeContextPackageMessages(messages).hasSummarizableContent) {
    throw new Error("Cannot summarize an image-only context package without textual or tool facts");
  }
}

export async function summarizeContextPackageRounds(args: {
  messages: Message[];
  aux: ResolvedAuxClient;
  signal?: AbortSignal;
  /** Wraps each model request (trace scope + usage owner). */
  wrapRequest: <T>(request: () => Promise<T>) => Promise<T>;
  onUsage: (usage: TokenUsage) => void;
}): Promise<{ summary: string; estimatedTokens: number }> {
  const { client, maxContextTokens } = args.aux;
  const fitsAuxWindow = contextPackageRequestFits(SYSTEM_PROMPT, maxContextTokens);
  if (!fitsAuxWindow("x")) {
    throw new Error(
      `Auxiliary model context window (${maxContextTokens}) is too small for the context package template and output reserve`,
    );
  }

  // Every complete round or lossless fragment feeds the same rolling
  // nine-section merge.
  const pending = groupMessagesByApiRound(args.messages).map(
    (group) => serializeContextPackageMessages(group).text,
  );
  let summary: string | undefined;
  while (pending.length > 0) {
    const priorSummary = summary;
    const conversation = takeContextPackageWindow(
      pending,
      (candidate) => fitsAuxWindow(candidate, priorSummary),
      maxContextTokens,
    );
    const response = await args.wrapRequest(() =>
      client.createMessage({
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildContextPackagePromptFromSerialized(conversation, summary),
          },
        ],
        tools: [],
        maxTokens: CONTEXT_PACKAGE_MAX_OUTPUT_TOKENS,
        billingEnabled: true,
        requestVisible: false,
        usagePurpose: "context_package",
        reasoning: { mode: "off" },
        signal: args.signal,
      }),
    );
    if (response.usage) args.onUsage(response.usage);
    summary = response.text.trim();
    if (!summary) throw new Error("Context package summary was empty");
  }
  return {
    summary: summary!,
    estimatedTokens: estimateTokens([{ role: "user", content: summary! }]),
  };
}
