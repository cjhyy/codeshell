export interface RepoLike {
  id: string;
  name: string;
  path: string;
}

/** True on platforms whose filesystems are case-insensitive by default. */
export function isCaseInsensitivePlatform(): boolean {
  const p =
    typeof navigator !== "undefined" && typeof navigator.platform === "string"
      ? navigator.platform.toLowerCase()
      : "";
  // darwin ("MacIntel"/"MacARM") + windows ("Win32") → case-insensitive.
  // Linux ("Linux x86_64") → case-sensitive. Unknown → insensitive (safer:
  // we'd rather over-match an existing repo than wrongly auto-create one).
  if (p.includes("mac") || p.includes("win")) return true;
  if (p.includes("linux")) return false;
  return true;
}

/**
 * Strip trailing slashes (keep a lone "/") and optionally lowercase.
 * Expects POSIX-separator paths — the engine always emits POSIX cwd
 * strings; Windows backslash paths are not normalized.
 */
export function normalizeCwd(cwd: string, caseInsensitive: boolean): string {
  let out = cwd.replace(/\/+$/, "");
  if (out === "") out = "/";
  return caseInsensitive ? out.toLowerCase() : out;
}

/**
 * True when `cwd` is the internal "no-repo" sandbox (`~/.code-shell/no-repo`,
 * any home dir) or empty/missing. These are NOT real projects — a session run
 * there is a no-project chat. Callers that map cwd→repo must route these to the
 * NO_REPO_KEY bucket (chat) instead of creating a bogus "no-repo" project (which
 * would otherwise show a project in the sidebar and pop a trust gate for the
 * sandbox dir). Matches the exact trailing segment `.code-shell/no-repo`, so a
 * real project like `.../no-repo-clone` does not falsely match.
 */
export function isNoRepoCwd(cwd: string | undefined | null): boolean {
  if (!cwd) return true;
  const norm = cwd.replace(/\/+$/, "");
  // The internal no-repo sandbox.
  if (norm.endsWith("/.code-shell/no-repo") || norm.endsWith("\\.code-shell\\no-repo")) return true;
  // Ephemeral / temp scratch dirs — test runs and tools (mkdtemp $TMPDIR) use
  // these as cwd; they are never a real project and must not spawn a sidebar
  // repo. Anchored to path prefixes so a real project like ".../tmp-project"
  // or ".../Documents/var/app" does NOT match.
  if (
    norm.startsWith("/tmp/") ||
    norm.startsWith("/private/tmp/") ||
    norm.startsWith("/var/folders/") ||
    norm.startsWith("/private/var/folders/")
  ) {
    return true;
  }
  return false;
}

/** Return the id of the repo whose path equals `cwd` (normalized), or null. */
export function matchRepoIdForCwd(
  cwd: string,
  repos: RepoLike[],
  caseInsensitive: boolean,
): string | null {
  const target = normalizeCwd(cwd, caseInsensitive);
  for (const r of repos) {
    if (normalizeCwd(r.path, caseInsensitive) === target) return r.id;
  }
  return null;
}
