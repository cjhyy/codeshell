/**
 * Token counter — best-effort live token count for streaming output.
 *
 * Uses gpt-tokenizer's cl100k_base encoding. It's exact for GPT-4 family and
 * close enough (within ~10%) for Claude/DeepSeek/Qwen for the purpose of a
 * live counter in the UI. The authoritative number is still the provider's
 * `usage` field, captured at end-of-stream.
 *
 * The encoder is lazy-initialized on first use so we don't pay the cost on
 * startup for sessions that never stream.
 */

type EncodeFn = (text: string) => number[];

let encoderPromise: Promise<EncodeFn> | null = null;

async function getEncoder(): Promise<EncodeFn> {
  if (!encoderPromise) {
    encoderPromise = import("gpt-tokenizer").then((mod) => mod.encode);
  }
  return encoderPromise;
}

let encoderSync: EncodeFn | null = null;

// Kick off the import so synchronous callers can use it on the next tick.
// First call still falls back to a length estimate.
void getEncoder().then((fn) => {
  encoderSync = fn;
});

/**
 * Count tokens in `text`. Synchronous. If the encoder isn't loaded yet,
 * falls back to chars/4 — only happens for the very first stream chunk in a
 * cold process.
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  if (encoderSync) return encoderSync(text).length;
  return Math.ceil(text.length / 4);
}
