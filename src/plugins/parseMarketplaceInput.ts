/**
 * Parse a user-typed marketplace identifier into a MarketplaceSource.
 * MVP subset of Claude Code's utils/plugins/parseMarketplaceInput.ts —
 * local absolute paths, github shorthand, https git URLs, and ssh git URLs.
 */

import type { MarketplaceSource } from "./types.js";

/**
 * Returns the parsed source, or null when the input does not match any
 * supported pattern. Callers should show a usage hint on null.
 */
export function parseMarketplaceInput(input: string): MarketplaceSource | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;

  // Absolute local path to a git repository (bare or with .git suffix).
  // Useful for dev workflows where the marketplace lives on disk rather
  // than at a remote URL. git clone itself accepts the same form.
  if (
    (trimmed.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(trimmed)) &&
    trimmed.endsWith(".git")
  ) {
    return { source: "git", url: trimmed };
  }

  // SSH: user@host:path[.git]
  // Username can contain alphanumeric, dots, underscores, hyphens.
  const sshMatch = trimmed.match(/^[a-zA-Z0-9._-]+@[^:\s]+:[^\s]+$/);
  if (sshMatch) {
    return { source: "git", url: trimmed };
  }

  // HTTPS
  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (parsed.hostname === "github.com" || parsed.hostname === "www.github.com") {
      const m = parsed.pathname.match(/^\/([^/]+\/[^/]+?)(\/|\.git|$)/);
      if (!m) return null;
      const url = trimmed.endsWith(".git") ? trimmed : `${trimmed}.git`;
      return { source: "git", url };
    }
    if (trimmed.endsWith(".git")) {
      return { source: "git", url: trimmed };
    }
    return null;
  }

  // GitHub shorthand: owner/repo (single slash, no protocol, no spaces)
  const shorthandMatch = trimmed.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9._-]+?)(\.git)?$/);
  if (shorthandMatch) {
    const owner = shorthandMatch[1];
    const repo = shorthandMatch[2];
    return { source: "github", repo: `${owner}/${repo}` };
  }

  return null;
}

/**
 * Derive a stable marketplace name from a source. Used as the filesystem
 * directory and the key in known_marketplaces.json.
 */
export function deriveMarketplaceName(source: MarketplaceSource): string {
  if (source.source === "github") {
    const parts = source.repo.split("/");
    return parts[parts.length - 1]!.toLowerCase();
  }
  // git: strip protocol, strip trailing .git, take last segment.
  // Local path /tmp/foo/skills.git → name "skills"
  // Local path /tmp/skills.git     → name "skills"
  const stripped = source.url.replace(/\.git$/, "");
  const segments = stripped.split(/[/:]/).filter(Boolean);
  const tail = segments[segments.length - 1] ?? "marketplace";
  return tail.toLowerCase();
}
