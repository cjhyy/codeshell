/**
 * Small renderer-local bridge for surfaces that want to put reviewed text in
 * the main composer without sending it. The App-owned chat state is the only
 * listener; extension pages only publish a bounded request.
 */

export const COMPOSER_SEED_REQUEST_EVENT = "codeshell:composer-seed-request";
export const MAX_COMPOSER_SEED_CHARS = 32_768;

export type ComposerSeedSource = "plugin-starter-prompt";

export interface ComposerSeedRequest {
  text: string;
  source: ComposerSeedSource;
}

export function normalizeComposerSeedRequest(value: unknown): ComposerSeedRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.source !== "plugin-starter-prompt") return null;
  if (
    typeof input.text !== "string" ||
    input.text.trim().length === 0 ||
    input.text.length > MAX_COMPOSER_SEED_CHARS
  ) {
    return null;
  }
  return { text: input.text, source: input.source };
}

/** Publish a composer-only request. Returns false instead of emitting invalid text. */
export function requestComposerSeed(request: ComposerSeedRequest): boolean {
  const normalized = normalizeComposerSeedRequest(request);
  if (!normalized) return false;
  window.dispatchEvent(
    new CustomEvent(COMPOSER_SEED_REQUEST_EVENT, {
      detail: normalized,
    }),
  );
  return true;
}

/** Register the App-side consumer and return its exact cleanup function. */
export function onComposerSeedRequest(
  listener: (request: ComposerSeedRequest) => void,
): () => void {
  const onRequest = (event: Event): void => {
    const request = normalizeComposerSeedRequest((event as CustomEvent<unknown>).detail);
    if (request) listener(request);
  };
  window.addEventListener(COMPOSER_SEED_REQUEST_EVENT, onRequest);
  return () => window.removeEventListener(COMPOSER_SEED_REQUEST_EVENT, onRequest);
}
