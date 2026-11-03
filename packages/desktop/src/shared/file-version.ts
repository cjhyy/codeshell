export type FileVersionUnavailableReason =
  | "object-missing"
  | "mismatch"
  | "not-a-repository"
  | "repository-mismatch"
  | "too-large"
  | "binary"
  | "invalid-utf8"
  | "read-failed";
export type FileVersionResult =
  | { status: "ok"; text: string; size: number; commit: string; blob: string; repoPath: string }
  | { status: "unavailable"; reason: FileVersionUnavailableReason };
