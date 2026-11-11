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
export function createReplyModels(cwd: string, options: { maxTokens?: number } = {}): ReplyModel[] {
  type Settings = ReturnType<SettingsManager["get"]>;
  const aux = (settings: Settings) => resolveAuxKey(settings);
  const main = (settings: Settings) => petChatModelKeyFromSettings(settings) ?? undefined;
  const call =
    (pick: (settings: Settings) => string | undefined, after?: typeof pick): ReplyModel =>
    async ({ systemPrompt, user, signal }) => {
      const settings = new SettingsManager(cwd, "full").get();
      const resolved = resolveLLMConfigForTag(settings, "text", pick(settings));
      if (!resolved) throw new Error("no text model is configured");
      // The same model as the one tried before: asking it again cannot help.
      const earlier = after ? resolveLLMConfigForTag(settings, "text", after(settings)) : null;
      if (earlier && JSON.stringify(earlier) === JSON.stringify(resolved))
        throw new Error("same model as the auxiliary one");
      const client = await createLLMClient(resolved);
      const response = await client.createMessage({
        systemPrompt,
        messages: [{ role: "user", content: user }],
        tools: [],
        reasoning: { mode: "off" },
        requestVisible: false,
        // A small JSON object: the owner's words are never echoed back at length
        // (a brief's write-up asks for more).
        maxTokens: options.maxTokens ?? 1_000,
        signal,
      });
      return response.text ?? "";
    };
  return [call(aux), call(main, aux)];
}
