type LinkNavigation = "allow" | "callback" | "deny";

const githubOrigin = "https://github.com";
const githubCallbackPath = "/oauth/upstream/github/callback";

/** Only the configured Link service can open the fixed GitHub authorization flow. */
export function createNativeLinkNavigationPolicy(authorizationUrl: string, redirectUri: string) {
  const issuer = new URL(authorizationUrl).origin;
  const callback = new URL(redirectUri);
  let githubAuthorization = false;

  return (target: string, mainFrame: boolean): LinkNavigation => {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return "deny";
    }
    if (url.username || url.password || !mainFrame) return "deny";
    if (url.origin === callback.origin && url.pathname === callback.pathname)
      return githubAuthorization ? "deny" : "callback";
    if (url.origin === issuer) {
      if (githubAuthorization && url.pathname !== githubCallbackPath) return "deny";
      githubAuthorization = false;
      return "allow";
    }
    if (url.origin !== githubOrigin) return "deny";
    if (githubAuthorization) return "allow";
    if (
      url.pathname !== "/login/oauth/authorize" ||
      url.hash ||
      !["client_id", "state"].every(
        (key) =>
          url.searchParams.getAll(key).length === 1 && Boolean(url.searchParams.get(key)?.trim()),
      )
    )
      return "deny";
    // This phase can only begin on the service page or its redirect chain. Returning
    // through the exact upstream callback ends it, including multi-hop redirects.
    githubAuthorization = true;
    return "allow";
  };
}
