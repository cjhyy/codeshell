import type { ProfileCredentialRevisions } from "@cjhyy/code-shell-core/internal/storage";
import type { ResolvedRendererConfigurationTarget } from "../main/renderer-configuration-authority.js";

export type ProfileSwitchTarget = Exclude<ResolvedRendererConfigurationTarget, { kind: "no-repo" }>;
export type { SourceCredentialQuestion as ProfileCredentialQuestion } from "@cjhyy/code-shell-core/internal";
export interface ProfileCredentialAnswers {
  decisions: { key: string; available: boolean; revision?: string }[];
  revisions?: ProfileCredentialRevisions;
}
