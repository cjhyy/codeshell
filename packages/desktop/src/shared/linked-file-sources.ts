import type { LinkFileSelectionInput, MaskedLinkConnection } from "@cjhyy/code-shell-link";

export interface LinkedFileConnectionView {
  id: string;
  providerId: string;
  label: string;
  accountLabel?: string;
  /** Opaque review token binds this exact saved connection and current project primary root. */
  revision: string;
  selection: "github-file" | "figma-file";
  /** Authoritative remote resource ids, never account resource display labels. */
  resources: Array<{ id: string; label: string }>;
  resourceRestricted: boolean;
}

export interface LinkedFileSourceSnapshot {
  connections: LinkedFileConnectionView[];
  limitations: Array<{
    providerId: string;
    label: string;
    reason: "document-content-unavailable" | "file-selection-unavailable";
  }>;
}

export interface AddLinkedFileSourcesInput {
  connectionId: string;
  expectedRevision: string;
  files: LinkFileSelectionInput[];
  priority: "normal" | "high";
}

export interface LinkedFileSourceApi {
  snapshot(projectId: string): Promise<LinkedFileSourceSnapshot>;
  add(projectId: string, input: AddLinkedFileSourcesInput): Promise<{ sourceIds: string[] }>;
}

export interface LinkedFileProject {
  projectId: string;
  rootId: string;
  cwd: string;
  canonicalIdentity: string;
}

export interface StoredLinkedFiles {
  connections: MaskedLinkConnection[];
  revisions: import("@cjhyy/code-shell-core/internal/storage").ProfileCredentialRevisions;
}
export interface LinkedFileCommit {
  project: LinkedFileProject;
  input: AddLinkedFileSourcesInput;
  review: StoredLinkedFiles;
}

export type CommitLinkedFiles = (
  method: "sources/addLinkedFiles",
  input: LinkedFileCommit,
  signal: AbortSignal,
) => Promise<{ sourceIds: string[] }>;
