export type UpdaterFeedDecision =
  | {
      source: "environment";
      config: { provider: "generic"; url: string };
    }
  | {
      source: "builtin-github";
      config: { provider: "github"; owner: string; repo: string };
    }
  | { source: "packaged"; config: null };

/**
 * Resolve updater configuration without claiming that the installed version is
 * current. Directory-only macOS builds do not receive app-update.yml from
 * electron-builder, so they need the same public GitHub feed as release builds
 * in order to perform a real version comparison.
 */
export function updaterFeedDecision(
  explicitFeed: string | undefined,
  packagedConfigExists: boolean,
): UpdaterFeedDecision {
  const feed = explicitFeed?.trim();
  if (feed) {
    return {
      source: "environment",
      config: { provider: "generic", url: feed },
    };
  }
  if (packagedConfigExists) return { source: "packaged", config: null };
  return {
    source: "builtin-github",
    config: { provider: "github", owner: "cjhyy", repo: "codeshell" },
  };
}
