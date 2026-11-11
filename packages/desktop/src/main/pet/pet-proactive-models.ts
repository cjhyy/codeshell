import type { ReplyModel } from "./pet-notice-reply-interpreter.js";

/**
 * One strict-JSON question to the models in order (the auxiliary model, then
 * Mimi's main model; see pet-notice-reply-models.ts). The first answer the
 * parser accepts wins; undefined when none did (unavailable, failed, timed
 * out, or invalid output). The caller never guesses in that case.
 */
export async function askModels<T>(input: {
  models: readonly ReplyModel[];
  systemPrompt: string;
  user: string;
  parse: (raw: string) => T | undefined;
  timeoutMs?: number;
  onError?: (error: unknown, model: number) => void;
}): Promise<T | undefined> {
  for (const [index, model] of input.models.entries()) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        model({ systemPrompt: input.systemPrompt, user: input.user, signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("model timed out"));
          }, input.timeoutMs ?? 30_000);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
      const parsed = input.parse(raw);
      if (parsed !== undefined) return parsed;
      input.onError?.(new Error("model gave an invalid answer"), index);
    } catch (error) {
      input.onError?.(error, index);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return undefined;
}

/** The model's text as one JSON object (a surrounding Markdown code fence is a fixed format). */
export function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  let text = raw.trim();
  if (text.startsWith("```") && text.endsWith("```") && text.length >= 6) {
    const firstBreak = text.indexOf("\n");
    text = firstBreak < 0 ? text : text.slice(firstBreak + 1, -3).trim();
  }
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/** A one-line text the owner will read: trimmed, no control characters, at most `max`. */
export function oneLine(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(text))
    return undefined;
  return text;
}
