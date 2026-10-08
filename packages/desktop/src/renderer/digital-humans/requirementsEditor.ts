import {
  DIGITAL_HUMAN_PROFILE_LIMITS,
  normalizeDigitalHumanSkillRepo,
  type DigitalHumanProfileEntry,
} from "./types";

export type DigitalHumanRequirements = NonNullable<DigitalHumanProfileEntry["requires"]>;
export type RequirementError = "repository" | "skillNames" | "binary" | "version" | "hint";

/** Mirror WorkspaceProfileRequirementsSchema without importing core into the renderer. */
export function validateDigitalHumanRequirements(requires: DigitalHumanRequirements) {
  const { capabilityCount, capabilityName, requirementCount } = DIGITAL_HUMAN_PROFILE_LIMITS;
  const skills = requires.skills.map((requirement): RequirementError | null => {
    if (!normalizeDigitalHumanSkillRepo(requirement.repo)) return "repository";
    const names = requirement.skills ?? [];
    if (
      names.length > capabilityCount ||
      new Set(names).size !== names.length ||
      names.some(
        (name) =>
          !name.length ||
          name.length > capabilityName ||
          name.startsWith("-") ||
          name === "*" ||
          name.includes("\0"),
      )
    ) {
      return "skillNames";
    }
    return null;
  });
  const tools = requires.tools.map((tool): RequirementError | null => {
    if (!tool.bin.length || tool.bin.length > capabilityName) return "binary";
    if (tool.minVersion !== undefined && !/^\d+(\.\d+){0,2}$/.test(tool.minVersion)) {
      return "version";
    }
    if (tool.hint !== undefined && tool.hint.length > capabilityName) return "hint";
    return null;
  });
  const countExceeded =
    requires.skills.length > requirementCount || requires.tools.length > requirementCount;
  return {
    skills,
    tools,
    countExceeded,
    valid: !countExceeded && skills.every((error) => !error) && tools.every((error) => !error),
  };
}

/** Keep incomplete repository input in the draft so validation can explain it. */
export function replaceDigitalHumanSkillSourceDraft(
  current: DigitalHumanRequirements["skills"],
  name: string,
  value: string,
): DigitalHumanRequirements["skills"] {
  const next = current.flatMap((requirement) => {
    if (!requirement.skills?.includes(name)) return [requirement];
    const skills = requirement.skills.filter((skill) => skill !== name);
    return skills.length ? [{ ...requirement, skills }] : [];
  });
  if (!value.trim()) return next;
  const repo = normalizeDigitalHumanSkillRepo(value) ?? value;
  const index = next.findIndex(
    (requirement) => requirement.repo === repo && !requirement.fullDepth && requirement.skills,
  );
  if (index >= 0) {
    next[index] = {
      ...next[index],
      skills: [...(next[index].skills ?? []), name].sort((left, right) =>
        left.localeCompare(right),
      ),
    };
  } else {
    next.push({ source: "github", repo, skills: [name], scope: "project", fullDepth: false });
  }
  return next;
}

export function normalizeDigitalHumanRequirements(
  requires: DigitalHumanRequirements,
): DigitalHumanRequirements | undefined {
  if (!requires.skills.length && !requires.tools.length) return undefined;
  return {
    skills: requires.skills.map((requirement) => ({
      ...requirement,
      repo: normalizeDigitalHumanSkillRepo(requirement.repo) ?? requirement.repo,
    })),
    tools: requires.tools,
  };
}
