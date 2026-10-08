type LinkNavigation = "allow" | "callback" | "deny";

/** Reviewed entry points; the service catalog cannot add a credential-bearing origin. */
const upstreamEntries = {
  github: { origin: "https://github.com", path: /^\/login\/oauth\/authorize$/ },
  gitlab: { origin: "https://gitlab.com", path: /^\/oauth\/authorize$/ },
  sentry: { origin: "https://sentry.io", path: /^\/oauth\/authorize\/$/ },
  vercel: { origin: "https://vercel.com", path: /^\/integrations\/[a-z0-9][a-z0-9-]{0,99}\/new$/ },
  slack: { origin: "https://slack.com", path: /^\/oauth\/v2\/authorize$/ },
  notion: { origin: "https://api.notion.com", path: /^\/v1\/oauth\/authorize$/ },
  linear: { origin: "https://linear.app", path: /^\/oauth\/authorize$/ },
  todoist: { origin: "https://app.todoist.com", path: /^\/oauth\/authorize$/ },
  airtable: { origin: "https://airtable.com", path: /^\/oauth2\/v1\/authorize$/ },
  figma: { origin: "https://www.figma.com", path: /^\/oauth$/ },
} as const;

/** A Link flow is bound to one reviewed provider and its exact service callback. */
export function createNativeLinkNavigationPolicy(authorizationUrl: string, redirectUri: string) {
  const authorization = new URL(authorizationUrl);
  const issuer = authorization.origin;
  const callback = new URL(redirectUri);
  const ids = authorization.searchParams.getAll("provider_id");
  const providerId = ids.length === 0 ? "github" : ids.length === 1 ? ids[0]! : "";
  const provider = Object.hasOwn(upstreamEntries, providerId)
    ? upstreamEntries[providerId as keyof typeof upstreamEntries]
    : undefined;
  const upstreamCallbackPath = `/oauth/upstream/${providerId}/callback`;
  let upstreamAuthorization = false;

  return (target: string, mainFrame: boolean): LinkNavigation => {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return "deny";
    }
    if (!provider || url.username || url.password || !mainFrame) return "deny";
    if (url.origin === callback.origin && url.pathname === callback.pathname)
      return upstreamAuthorization ? "deny" : "callback";
    if (url.origin === issuer) {
      if (upstreamAuthorization && url.pathname !== upstreamCallbackPath) return "deny";
      upstreamAuthorization = false;
      return "allow";
    }
    if (url.origin !== provider.origin) return "deny";
    if (upstreamAuthorization) return "allow";
    const required = providerId === "vercel" ? ["state", "redirect_uri"] : ["client_id", "state"];
    if (
      !provider.path.test(url.pathname) ||
      url.hash ||
      !required.every(
        (key) =>
          url.searchParams.getAll(key).length === 1 && Boolean(url.searchParams.get(key)?.trim()),
      )
    )
      return "deny";
    if (providerId === "vercel") {
      let installationCallback: URL;
      try {
        installationCallback = new URL(url.searchParams.get("redirect_uri")!);
      } catch {
        return "deny";
      }
      if (
        installationCallback.origin !== issuer ||
        installationCallback.pathname !== upstreamCallbackPath ||
        installationCallback.search ||
        installationCallback.hash ||
        installationCallback.username ||
        installationCallback.password
      )
        return "deny";
    }
    // The exact upstream callback ends this phase before a Host callback is allowed.
    upstreamAuthorization = true;
    return "allow";
  };
}
