import type { ExternalGitBlobRef } from "@cjhyy/code-shell-core";
import type { ProjectAuthorityApi } from "../preload/project-authority-types.js";
import type { ReviewAiPromptRequest, ReviewGitDiffRequest } from "./review.js";

type Read<K extends keyof ProjectAuthorityApi, P> = {
  params: P;
  result: ProjectAuthorityApi[K] extends (...args: any[]) => Promise<infer R> ? R : never;
};
export type FileRoot = { owner: { projectId: string } | { sessionId: string }; rootId: string };
type Project = { projectId: string };
type Session = { sessionId: string };

export interface WorkspaceReadContracts {
  "files/list": Read<"readProjectDir", FileRoot & { dir?: string }>;
  "files/read": Read<"readProjectFileContent", FileRoot & { path: string }>;
  "files/exists": Read<"projectFileExists", FileRoot & { path: string }>;
  "files/version": Read<"readProjectFileVersion", FileRoot & { ref: ExternalGitBlobRef }>;
  "files/searchProject": Read<"searchProjectFiles", Project & { query: string; rootId?: string }>;
  "git/projectStatus": Read<"getProjectGitStatus", Project>;
  "git/projectBranches": Read<"getProjectGitBranches", Project>;
  "review/status": Read<"getReviewStatus", Session>;
  "review/diff": Read<"getReviewDiff", Session & { request: ReviewGitDiffRequest }>;
  "review/prompt": Read<"prepareReviewPrompt", Session & { request: ReviewAiPromptRequest }>;
  "review/commits": Read<"getReviewRecentCommits", Session & { limit?: number }>;
}
