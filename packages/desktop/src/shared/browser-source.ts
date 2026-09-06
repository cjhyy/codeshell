/**
 * Where a browser comes from, as a first-class fact.
 *
 * "Which browser" used to be implicit — whatever guest happened to be active.
 * That is tolerable while only the built-in sandbox exists, but once the agent
 * can drive the user's own Chrome the source becomes a SAFETY property: a
 * misclick in a throwaway partition pollutes a disposable cookie jar, while the
 * same misclick in the user's real browser can be an actual transfer or post.
 *
 * See docs/todo/browser-profile-workspace-lease-design.md §6.
 */

export type BrowserSource =
  | { kind: "builtin-panel"; profileId: string }
  | { kind: "builtin-headless"; profileId: string }
  | { kind: "attached-chrome"; endpoint: string; browserId: string }
  | { kind: "remote"; endpoint: string; browserId: string };

/** The ordinary in-app source for a profile. */
export function builtinPanelSource(profileId: string): BrowserSource {
  return { kind: "builtin-panel", profileId };
}

/**
 * True only for the user's OWN browser, carrying their real logins.
 *
 * A remote server browser is deliberately excluded: it holds server-side
 * credentials, not the person's Chrome profile, so warning about "your real
 * accounts" there would be false.
 */
export function isUserOwnedSource(source: BrowserSource): boolean {
  return source.kind === "attached-chrome";
}

/**
 * Whether sensitive actions must always be approved for this source.
 *
 * External sources (the user's Chrome, a remote browser) cannot fall back on
 * the learned-ref shortcut that makes repeat actions cheap inside the sandbox:
 * the blast radius is real accounts or shared server state.
 */
export function requiresStrictApproval(source: BrowserSource): boolean {
  return source.kind === "attached-chrome" || source.kind === "remote";
}

export type DebugEndpointResult =
  | { ok: true; endpoint: string }
  | { ok: false; reason: "invalid" | "bad_scheme" | "not_loopback" | "no_port" };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Validate a Chrome `--remote-debugging-port` endpoint.
 *
 * Loopback ONLY, and this is the load-bearing rule: the DevTools protocol port
 * is unauthenticated, so whoever can reach it controls the browser completely.
 * Accepting a routable host would hand the user's logged-in Chrome to anything
 * listening on that network. A missing port is refused rather than defaulted,
 * so a bare host can never silently resolve to :80.
 */
export function parseDebugEndpoint(raw: string): DebugEndpointResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "bad_scheme" };
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) return { ok: false, reason: "not_loopback" };
  if (!url.port) return { ok: false, reason: "no_port" };
  return { ok: true, endpoint: `${url.protocol}//${url.hostname}:${url.port}` };
}

/** One short line naming the source, for the model and for the UI. */
export function describeBrowserSource(source: BrowserSource): string {
  switch (source.kind) {
    case "builtin-panel":
      return `内置浏览器面板（${source.profileId}）`;
    case "builtin-headless":
      return `内置后台浏览器（${source.profileId}）`;
    case "attached-chrome":
      // Say it in words: an endpoint alone conveys no risk.
      return `你自己的浏览器（${source.endpoint}）—— 操作会影响你的真实账号`;
    case "remote":
      return `服务端浏览器（${source.endpoint}）`;
  }
}
