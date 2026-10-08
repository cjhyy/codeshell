import type { ProfileSwitchImpact } from "@cjhyy/code-shell-core/internal";

export interface ProfileSwitchSourceSummary {
  sourceId: string;
  label: string;
  scopes: string[];
  readPolicy: "ask" | "deny";
  status: "ok" | "dangling" | "unavailable";
}

/** Deliberately excludes instruction/memory bodies, paths, credentials and source definitions. */
export interface ProfileSwitchPreview extends ProfileSwitchImpact {
  revision: string;
  target: { kind: "project" | "session"; projectId: string | null; sessionId?: string };
  sources: { before: ProfileSwitchSourceSummary[]; after: ProfileSwitchSourceSummary[] };
  exclusiveSkillsOnly: boolean;
}

export type ProfileSwitchAdoptResult = { status: "adopted" } | { status: "stale" };
