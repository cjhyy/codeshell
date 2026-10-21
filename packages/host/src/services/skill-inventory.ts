import { SettingsManager, scanSkills, invalidateSkillCache } from "@cjhyy/code-shell-core";
import { computeEffectiveDisabledLists } from "@cjhyy/code-shell-core/internal";
import { isAbsolute } from "node:path";

/** Discovery and effective toggles only. Grants and mutations belong to the adapter. */
export function readSkillInventory(cwd: string, options: { refresh?: boolean } = {}) {
  if (!isAbsolute(cwd)) throw new Error("Skill inventory requires an absolute workspace");
  if (options.refresh) invalidateSkillCache();
  const disabled = computeEffectiveDisabledLists(new SettingsManager(cwd, "full"), cwd);
  const enabledPaths = new Set(scanSkills(cwd, disabled).map((skill) => skill.filePath));
  // Keep project binding even when showing individually disabled skills/plugins.
  const skills = scanSkills(cwd).map((definition) => ({
    definition,
    enabled: enabledPaths.has(definition.filePath),
  }));
  return { skills, ...disabled };
}
