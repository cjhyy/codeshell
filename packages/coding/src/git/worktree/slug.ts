/** Default branch namespace for coding worktrees. */
export const DEFAULT_WORKTREE_BRANCH_PREFIX = "worktree/";
export const HISTORICAL_WORKTREE_BRANCH_PREFIX = "worktree/";

/**
 * Validate worktree slug to prevent path traversal attacks.
 */
export function validateWorktreeSlug(slug: string): void {
  if (slug.trim().length === 0) throw new Error("Worktree slug cannot be empty");
  if (slug.length > 64) throw new Error("Worktree slug too long (max 64 chars)");
  if (/[^a-zA-Z0-9._-]/.test(slug)) throw new Error("Worktree slug contains invalid characters");
  if (slug.startsWith(".") || slug.includes(".."))
    throw new Error("Worktree slug cannot start with '.' or contain '..'");
}

export function normalizeWorktreeBranchPrefix(
  prefix: string | undefined = DEFAULT_WORKTREE_BRANCH_PREFIX,
): string {
  const raw = (prefix ?? DEFAULT_WORKTREE_BRANCH_PREFIX).trim();
  if (!isValidWorktreeBranchPrefix(raw)) {
    throw new Error(`Invalid worktree branch prefix: ${prefix ?? ""}`);
  }
  return raw.endsWith("/") ? raw : `${raw}/`;
}

export function isValidWorktreeBranchPrefix(prefix: string): boolean {
  const raw = prefix.trim();
  if (!raw) return false;
  if (raw.startsWith("/") || raw.includes("//")) return false;
  if (raw.includes("..") || raw.includes("@{")) return false;
  if (/[\x00-\x20~^:?*[\]\\]/.test(raw)) return false;

  const withoutTrailingSlash = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  if (!withoutTrailingSlash) return false;

  return withoutTrailingSlash.split("/").every((part) => {
    if (!part) return false;
    if (part.startsWith(".") || part.endsWith(".")) return false;
    if (part.endsWith(".lock")) return false;
    return true;
  });
}

export function applyPrefix(prefix: string | undefined, slug: string, sessionId: string): string {
  validateWorktreeSlug(slug);
  return `${normalizeWorktreeBranchPrefix(prefix)}${slug}-${sessionId.slice(0, 8)}`;
}

export function managedBranchPrefixes(prefix?: string): string[] {
  const configured = normalizeWorktreeBranchPrefix(prefix);
  return configured === HISTORICAL_WORKTREE_BRANCH_PREFIX
    ? [configured]
    : [configured, HISTORICAL_WORKTREE_BRANCH_PREFIX];
}

export function isManagedWorktreeBranch(branch: string, prefix?: string): boolean {
  return managedBranchPrefixes(prefix).some((candidate) => branch.startsWith(candidate));
}
