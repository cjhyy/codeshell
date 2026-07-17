import type { WorkspaceProfile } from "@cjhyy/code-shell-core";

export interface DigitalHumanProfileCapabilityCounts {
  plugins: number;
  skills: number;
  mcp: number;
  agents: number;
  total: number;
}

/** Authoritative, Schema-normalized preview produced by Desktop main. */
export interface DigitalHumanProfileImportPreview {
  reviewToken: string;
  sourceFileName: string;
  name: string;
  label: string;
  description?: string;
  basePreset: string;
  version?: string;
  portableMemory: boolean;
  capabilityCounts: DigitalHumanProfileCapabilityCounts;
  alreadyExists: boolean;
}

export type DigitalHumanProfileImportPickResult =
  | { canceled: true }
  | { canceled: false; preview: DigitalHumanProfileImportPreview };

export type DigitalHumanProfileImportCommitResult =
  | { ok: true; name: string; label: string }
  | { ok: false; alreadyExists: true; name: string; label: string };

export interface DigitalHumanProfileImportCommitInput {
  reviewToken: string;
  overwrite?: boolean;
}

export type DigitalHumanProfileExportResult =
  | { canceled: true }
  | { canceled: false; fileName: string; name: string; label: string };

/** Internal main-process snapshot stored behind a review token. */
export interface ReviewedDigitalHumanProfile {
  profile: WorkspaceProfile;
  sourceFileName: string;
}
