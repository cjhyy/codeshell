/**
 * Test helper: build a stub that satisfies the FULL `typeof globalThis.fetch`.
 *
 * WHY THIS EXISTS
 * ---------------
 * Assigning a plain `async () => new Response(...)` to `globalThis.fetch` used
 * to typecheck. Bun 1.3 added a static `fetch.preconnect(url)`, so the global's
 * type now carries that property and every bare-function stub fails with:
 *   Property 'preconnect' is missing in type '() => Promise<Response>'
 *   but required in type 'typeof fetch'.
 *
 * The runtime behavior never changed — only the static surface. Rather than
 * sprinkling `as unknown as typeof fetch` (which silences real mismatches too)
 * at each site, attach the missing statics once, here. When a future runtime
 * adds another property to `fetch`, this is the single place to update.
 *
 * Prefer narrowing the PRODUCTION type instead when the code under test only
 * ever *calls* fetch — see `PanelAppArchiveFetch` in ../panel-apps/github-archive.ts.
 * Use this helper only where the real global genuinely has to be replaced.
 */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Wrap a call-only fetch implementation so it is assignable to
 * `globalThis.fetch`.
 *
 * ```ts
 * const previous = globalThis.fetch;
 * globalThis.fetch = asGlobalFetch(async () => new Response("ok"));
 * try { … } finally { globalThis.fetch = previous; }
 * ```
 */
export function asGlobalFetch(impl: FetchLike): typeof globalThis.fetch {
  const stub = impl as unknown as typeof globalThis.fetch;
  // `preconnect` is a no-op hint even in production; tests never assert on it.
  if (typeof (stub as { preconnect?: unknown }).preconnect !== "function") {
    Object.defineProperty(stub, "preconnect", {
      value: (_url: string | URL) => {
        /* no-op: connection warm-up is unobservable in tests */
      },
      configurable: true,
      writable: true,
    });
  }
  return stub;
}
