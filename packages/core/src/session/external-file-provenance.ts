/** Completion-time metadata only; this protocol never contains file snapshots. */
export interface ExternalGitBlobRef {
  kind: "git-blob";
  commit: string;
  blob: string;
  repoPath: string;
  worktreePath: string;
  linkedWorktree: boolean;
  branch?: string;
  /** SHA256 of canonical Git common directory and filesystem identity, binding that repository instance. */
  repositoryId?: string;
}
export interface ExternalChangedFileRef {
  path: string;
  absolutePath: string;
  presence: "present" | "missing" | "not-regular" | "unknown";
  size?: number;
  contentRef?: ExternalGitBlobRef;
  versionStatus?:
    | "recorded"
    | "uncommitted"
    | "untracked"
    | "outside-repository"
    | "unsupported"
    | "probe-failed"
    | "skipped-limit";
}
export interface ExternalChangedFilesProvenance {
  schemaVersion: 1;
  cli: "claude" | "codex";
  observedAt: number;
  capture: "completion";
  files: ExternalChangedFileRef[];
}
const bounded = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 4096 && !v.includes("\0");
const absolute = (v: unknown): boolean =>
  bounded(v) && (/^\//.test(v) || /^[a-z]:[\\/]/i.test(v) || /^\\\\/.test(v));
const oid = (v: unknown): v is string =>
  typeof v === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(v);
export function sanitizeGitBlobRef(value: unknown): ExternalGitBlobRef | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const v = value as ExternalGitBlobRef;
    if (
      v.kind !== "git-blob" ||
      !oid(v.commit) ||
      !oid(v.blob) ||
      v.commit.length !== v.blob.length ||
      !bounded(v.repoPath) ||
      absolute(v.repoPath) ||
      v.repoPath.includes("\\") ||
      v.repoPath.split("/").some((s) => !s || s === "." || s === "..") ||
      !absolute(v.worktreePath) ||
      typeof v.linkedWorktree !== "boolean"
    )
      return;
    if (v.branch !== undefined && !bounded(v.branch)) return;
    if (
      v.repositoryId !== undefined &&
      (typeof v.repositoryId !== "string" || !/^[a-f0-9]{64}$/.test(v.repositoryId))
    )
      return;
    return {
      kind: "git-blob",
      commit: v.commit.toLowerCase(),
      blob: v.blob.toLowerCase(),
      repoPath: v.repoPath,
      worktreePath: v.worktreePath,
      linkedWorktree: v.linkedWorktree,
      ...(v.branch !== undefined ? { branch: v.branch } : {}),
      ...(v.repositoryId !== undefined ? { repositoryId: v.repositoryId } : {}),
    };
  } catch {
    return;
  }
}
/** Untrusted journal/transcript/notification input: bad entries cannot discard a completion. */
export function sanitizeExternalChangedFilesProvenance(
  value: unknown,
  changedFiles: readonly string[],
): ExternalChangedFilesProvenance | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const v = value as ExternalChangedFilesProvenance;
    if (
      v.schemaVersion !== 1 ||
      !["claude", "codex"].includes(v.cli) ||
      v.capture !== "completion" ||
      typeof v.observedAt !== "number" ||
      !Number.isFinite(v.observedAt) ||
      v.observedAt < 0 ||
      v.observedAt > 8_640_000_000_000_000 ||
      !Array.isArray(v.files)
    )
      return;
    const allowed = new Set(changedFiles);
    const files: ExternalChangedFileRef[] = [];
    const seen = new Set<string>();
    for (const entry of v.files.slice(0, 100)) {
      try {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const { path, absolutePath, presence, size, versionStatus } = entry;
        if (
          !bounded(path) ||
          !allowed.has(path) ||
          seen.has(path) ||
          !absolute(absolutePath) ||
          !["present", "missing", "not-regular", "unknown"].includes(presence)
        )
          continue;
        if (size !== undefined && (!Number.isSafeInteger(size) || size < 0)) continue;
        if (
          versionStatus !== undefined &&
          ![
            "recorded",
            "uncommitted",
            "untracked",
            "outside-repository",
            "unsupported",
            "probe-failed",
            "skipped-limit",
          ].includes(versionStatus)
        )
          continue;
        const contentRef =
          presence === "present" && (versionStatus === undefined || versionStatus === "recorded")
            ? sanitizeGitBlobRef(entry.contentRef)
            : undefined;
        files.push({
          path,
          absolutePath,
          presence,
          ...(size !== undefined ? { size } : {}),
          ...(versionStatus
            ? {
                versionStatus:
                  versionStatus === "recorded" && !contentRef ? "probe-failed" : versionStatus,
              }
            : {}),
          ...(contentRef ? { contentRef } : {}),
        });
        seen.add(path);
      } catch {
        /* isolate a damaged entry */
      }
    }
    return { schemaVersion: 1, cli: v.cli, observedAt: v.observedAt, capture: "completion", files };
  } catch {
    return;
  }
}
