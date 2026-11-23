import type {
  InstalledSkill,
  InstallFromGithubInput,
  RepoInspection,
  SkillUpdateResult,
} from "@cjhyy/code-shell-core/internal/skills";
import type { RendererConfigurationTarget } from "./renderer-configuration.js";

type Scope =
  | { scope: "user"; target: null }
  | { scope: "project"; target: RendererConfigurationTarget };

export interface SkillOperations {
  "skills/inspectGithub": {
    input: { url: string; existingNames: string[] };
    result: RepoInspection;
  };
  "skills/installGithub": {
    input: Scope & Pick<InstallFromGithubInput, "inspection" | "selected" | "installName">;
    result: InstalledSkill;
  };
  "skills/installLocal": {
    input: Scope & { sourceDir: string; name?: string };
    result: InstalledSkill;
  };
  "skills/uninstall": { input: Scope & { skillName: string }; result: void };
  "skills/update": {
    input: { target: RendererConfigurationTarget | null; filePath: string };
    result: SkillUpdateResult;
  };
}
