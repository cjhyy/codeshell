import {
  SettingsManager,
  createLLMClient,
  resolveAuxKey,
  resolveLLMConfigForTag,
  type LLMConfig,
} from "@cjhyy/code-shell-core";
import { petChatModelKeyFromSettings } from "../../shared/pet-settings.js";
import { sessionModelKeyFromSettings } from "../../shared/session-model-default.js";
import { parseExternalRuntimeModelKey } from "../../shared/external-runtime-models.js";
import type { ReplyModel } from "./pet-notice-reply-interpreter.js";

type ReplyRequest = Parameters<ReplyModel>[0];
type Settings = ReturnType<SettingsManager["get"]>;

/** A Host-owned external interpreter, separate from Mimi's shared manager Session. */
export type ExternalReplyModel = (modelKey: string, request: ReplyRequest) => Promise<string>;

export interface ReplyModelOptions {
  maxTokens?: number;
  external?: ExternalReplyModel;
  readSettings?: () => Settings;
  callNative?: (
    config: LLMConfig,
    request: ReplyRequest,
    bounds: { maxTokens: number },
  ) => Promise<string>;
}

/**
 * Snapshot the effective provider for one interpretation. External selections
 * never admit a native candidate; native selections retain auxiliary → main.
 * The caller builds a fresh chain for each owner reply, so settings changes
 * apply on the next message without changing an in-flight request's provider.
 */
export function createReplyModels(cwd: string, options: ReplyModelOptions = {}): ReplyModel[] {
  let settings: Settings;
  try {
    settings = options.readSettings?.() ?? new SettingsManager(cwd, "full").get();
  } catch (error) {
    return [
      async () => {
        throw error;
      },
    ];
  }
  const selected = petChatModelKeyFromSettings(settings) ?? sessionModelKeyFromSettings(settings);
  if (parseExternalRuntimeModelKey(selected)) {
    return [
      async (request) => {
        request.signal.throwIfAborted();
        if (!options.external) throw new Error("外部通知回复模型尚未就绪，未切换到 API 模型。");
        return options.external(selected!, request);
      },
    ];
  }
  const aux = resolveAuxKey(settings);
  const main = selected ?? undefined;
  const callNative =
    options.callNative ??
    (async (resolved, { systemPrompt, user, signal }, bounds) => {
      const client = await createLLMClient(resolved);
      const response = await client.createMessage({
        systemPrompt,
        messages: [{ role: "user", content: user }],
        tools: [],
        reasoning: { mode: "off" },
        requestVisible: false,
        // A small JSON object: the owner's words are never echoed back at length
        // (a brief's write-up asks for more).
        maxTokens: bounds.maxTokens,
        signal,
      });
      return response.text ?? "";
    });
  const call =
    (pick: string | undefined, deduplicate = false): ReplyModel =>
    async (request) => {
      request.signal.throwIfAborted();
      const resolved = resolveLLMConfigForTag(settings, "text", pick);
      if (!resolved) throw new Error("no text model is configured");
      // The same model as the one tried before: asking it again cannot help.
      const earlier = deduplicate ? resolveLLMConfigForTag(settings, "text", aux) : null;
      if (earlier && JSON.stringify(earlier) === JSON.stringify(resolved))
        throw new Error("same model as the auxiliary one");
      return callNative(resolved, request, { maxTokens: options.maxTokens ?? 1_000 });
    };
  return [call(aux), call(main, true)];
}
