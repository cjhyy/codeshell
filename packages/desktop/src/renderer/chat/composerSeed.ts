/**
 * Small renderer-local bridge for surfaces that want to put reviewed text in
 * the main composer without sending it. The App-owned chat state is the only
 * listener; extension pages only publish a bounded request.
 */

export const COMPOSER_SEED_REQUEST_EVENT = "codeshell:composer-seed-request";
export const MAX_COMPOSER_SEED_CHARS = 32_768;

export type ComposerSeedRequest = { text: string } & (
  | { source: "plugin-starter-prompt" }
  | { source: "code-review"; sessionId: string }
);

export function normalizeComposerSeedRequest(value: unknown): ComposerSeedRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.source !== "plugin-starter-prompt" && input.source !== "code-review") return null;
  if (
    input.source === "code-review" &&
    (typeof input.sessionId !== "string" || !input.sessionId || input.sessionId.length > 1_024)
  ) {
    return null;
  }
  if (
    typeof input.text !== "string" ||
    input.text.trim().length === 0 ||
    input.text.length > MAX_COMPOSER_SEED_CHARS
  ) {
    return null;
  }
  return input.source === "code-review"
    ? { text: input.text, source: input.source, sessionId: input.sessionId as string }
    : { text: input.text, source: input.source };
}

/** Publish a composer-only request. Returns false instead of emitting invalid text. */
export function requestComposerSeed(request: ComposerSeedRequest): boolean {
  const normalized = normalizeComposerSeedRequest(request);
  if (!normalized) return false;
  const event = new CustomEvent(COMPOSER_SEED_REQUEST_EVENT, {
    detail: normalized,
    cancelable: true,
  });
  window.dispatchEvent(event);
  // Review preparation is asynchronous and Session-scoped. Report success
  // only when the App has synchronously accepted it into that Session's draft.
  return normalized.source === "code-review" ? event.defaultPrevented : true;
}

/** Register the App-side consumer and return its exact cleanup function. */
export function onComposerSeedRequest(
  listener: (request: ComposerSeedRequest) => unknown,
): () => void {
  const onRequest = (event: Event): void => {
    const request = normalizeComposerSeedRequest((event as CustomEvent<unknown>).detail);
    if (request && listener(request) === true) event.preventDefault();
  };
  window.addEventListener(COMPOSER_SEED_REQUEST_EVENT, onRequest);
  return () => window.removeEventListener(COMPOSER_SEED_REQUEST_EVENT, onRequest);
}
