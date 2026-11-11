import {
  SettingsManager,
  createLLMClient,
  resolveAuxKey,
  resolveLLMConfigForTag,
} from "@cjhyy/code-shell-core";
import { petChatModelKeyFromSettings } from "../../shared/pet-settings.js";
import type { ReplyModel } from "./pet-notice-reply-interpreter.js";

/**
 * The models that read owner replies, in order: the auxiliary text model
 * (the one closure summaries use), then Mimi's own chat model. Settings are
 * read on every call, so a model change applies without a restart. A model
 * that is not configured throws, and the next one is tried.
 */
export function createReplyModels(cwd: string): ReplyModel[] {
  const call =
    (pick: (settings: ReturnType<SettingsManager["get"]>) => string | undefined): ReplyModel =>
    async ({ systemPrompt, user, signal }) => {
      const settings = new SettingsManager(cwd, "full").get();
      const resolved = resolveLLMConfigForTag(settings, "text", pick(settings));
      if (!resolved) throw new Error("no text model is configured");
      const client = await createLLMClient(resolved);
      const response = await client.createMessage({
        systemPrompt,
        messages: [{ role: "user", content: user }],
        tools: [],
        reasoning: { mode: "off" },
        requestVisible: false,
        maxTokens: 400,
        signal,
      });
      return response.text ?? "";
    };
  return [
    call((settings) => resolveAuxKey(settings)),
    call((settings) => petChatModelKeyFromSettings(settings) ?? undefined),
  ];
}
