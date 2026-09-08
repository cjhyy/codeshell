/** Desktop uses the shared, platform-independent Skill source implementation. */
export {
  parseGithubUrl,
  inspectRepo,
  getRefCommit,
  downloadSkillTree,
  checkSkillUpdate,
  updateSkillFromSource,
  SKILL_META_FILE,
  type GithubUrlInfo,
  type DetectedSkill,
  type RepoInspection,
  type SkillSourceMeta,
  type SkillUpdateCheck,
  type InstallFromGithubInput,
  type SkillUpdateResult,
  type SkillUpdateDeps,
} from "@cjhyy/code-shell-core/internal/skills";

import {
  installFromGithub as installSharedGithubSkill,
  type InstallFromGithubInput,
} from "@cjhyy/code-shell-core/internal/skills";
import { rememberCodeShellMarkdownPath } from "./safe-read.js";

export async function installFromGithub(input: InstallFromGithubInput) {
  const installed = await installSharedGithubSkill(input);
  rememberCodeShellMarkdownPath(installed.filePath);
  return installed;
}
