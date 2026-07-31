import type { DigitalHumanTeam, DigitalHumanTeamMode } from "../../shared/digital-human-team";

/**
 * Mirrors core's WorkspaceProfile persistence boundary. Renderer code cannot
 * runtime-import core packages, so keep these values aligned with
 * WORKSPACE_PROFILE_LIMITS.
 */
export const DIGITAL_HUMAN_PROFILE_LIMITS = {
  id: 64,
  label: 120,
  description: 4_096,
  basePreset: 128,
  mainInstruction: 32_768,
  version: 128,
  capabilityCount: 128,
  capabilityName: 256,
  requirementCount: 16,
} as const;

export function canAddDigitalHumanSkill(selectedCount: number, name: string): boolean {
  return (
    selectedCount < DIGITAL_HUMAN_PROFILE_LIMITS.capabilityCount &&
    name.length > 0 &&
    name.length <= DIGITAL_HUMAN_PROFILE_LIMITS.capabilityName
  );
}

/**
 * Renderer-safe copy of core's argv-facing owner/repo boundary. Keeping this
 * validator pure makes the recovery flow testable without runtime-importing
 * core into the browser bundle.
 */
const DIGITAL_HUMAN_SKILL_REPO_RE =
  /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function normalizeDigitalHumanSkillRepo(value: string): string | null {
  const normalized = value.trim();
  return DIGITAL_HUMAN_SKILL_REPO_RE.test(normalized) ? normalized : null;
}

type DigitalHumanSkillRequirement = NonNullable<
  DigitalHumanProfileEntry["requires"]
>["skills"][number];

/**
 * Build the smallest deterministic set of requirements from per-Skill source
 * inputs. Skills sharing a repo are installed together; empty/invalid rows are
 * ignored and remain blocked by the editor's validation.
 */
export function digitalHumanSkillRequirementsFromSources(
  sources: Readonly<Record<string, string>>,
): DigitalHumanSkillRequirement[] {
  const skillsByRepo = new Map<string, string[]>();
  for (const [name, source] of Object.entries(sources).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const repo = normalizeDigitalHumanSkillRepo(source);
    if (!repo) continue;
    const names = skillsByRepo.get(repo) ?? [];
    names.push(name);
    skillsByRepo.set(repo, names);
  }
  return [...skillsByRepo.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([repo, skillNames]) => ({
      source: "github",
      repo,
      skills: skillNames,
      scope: "project",
      fullDepth: false,
    }));
}

/** Resolve explicit named Skill sources for pre-filling the editor. */
export function digitalHumanSkillSourcesByName(
  requires: DigitalHumanProfileEntry["requires"],
): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const requirement of requires?.skills ?? []) {
    for (const name of requirement.skills ?? []) {
      // Malformed imported definitions can name the same Skill more than once.
      // Keep the first source, matching the review order, and normalize the
      // definition the next time the user actually changes that row.
      if (!(name in sources)) sources[name] = requirement.repo;
    }
  }
  return sources;
}

/**
 * Replace only the named Skill rows the editor changed.
 *
 * Other authored requirements (including catch-all repositories and
 * fullDepth flags) are preserved byte-for-byte at the data-shape level. An
 * empty/invalid update removes the old named source; valid updates are grouped
 * by repository through the same deterministic builder used for new rows.
 */
export function replaceDigitalHumanSkillSources(
  current: readonly DigitalHumanSkillRequirement[],
  updates: Readonly<Record<string, string>>,
): DigitalHumanSkillRequirement[] {
  const changedNames = new Set(Object.keys(updates));
  if (changedNames.size === 0) return [...current];

  const preserved = current.flatMap((requirement) => {
    if (!requirement.skills?.length) return [requirement];
    const skills = requirement.skills.filter((name) => !changedNames.has(name));
    return skills.length > 0 ? [{ ...requirement, skills }] : [];
  });
  const next = [...preserved];
  for (const addition of digitalHumanSkillRequirementsFromSources(updates)) {
    const mergeIndex = next.findIndex(
      (requirement) =>
        requirement.repo === addition.repo &&
        requirement.fullDepth === addition.fullDepth &&
        requirement.skills !== undefined,
    );
    if (mergeIndex < 0) {
      next.push(addition);
      continue;
    }
    const target = next[mergeIndex];
    next[mergeIndex] = {
      ...target,
      skills: [...new Set([...(target.skills ?? []), ...(addition.skills ?? [])])].sort((left, right) =>
        left.localeCompare(right),
      ),
    };
  }
  return next;
}

export type DigitalHumanSelection =
  | { kind: "single"; id: string; label: string }
  | {
      kind: "team";
      id: string;
      label: string;
      members: string[];
      mode: DigitalHumanTeamMode;
      /** Full definition, so the launcher can build briefings (lead + playbook). */
      team: DigitalHumanTeam;
    };

export interface DigitalHumanProfileEntry {
  name: string;
  label: string;
  description?: string;
  basePreset: string;
  plugins: string[];
  skills: string[];
  mcp: string[];
  agents: string[];
  mainInstruction?: string;
  active: boolean;
  portableMemory: boolean;
  /**
   * true → 独占工作面：未声明的能力被显式关掉，而非与用户已开启的取并集。
   * schema 侧有 default(false)，故解析后必有值；旧数据经 schema 归一化。
   */
  exclusiveCapabilities: boolean;
  version?: string;
  /**
   * Dependency declaration (skill sources + required binaries). The editor
   * preserves authored requirements and can add a source for an older
   * definition's unsourced missing Skills.
   */
  requires?: {
    skills: Array<{
      source: "github";
      repo: string;
      skills?: string[];
      scope: "project";
      fullDepth: boolean;
    }>;
    tools: Array<{ bin: string; minVersion?: string; hint?: string }>;
  };
}

/**
 * Return configured, missing Skills that cannot be obtained from any declared
 * requirement. A requirement without an explicit Skill list installs the whole
 * repository and therefore covers every configured name.
 */
export function digitalHumanSkillsWithoutSource(
  missingSkillNames: readonly string[],
  requires: DigitalHumanProfileEntry["requires"],
): string[] {
  if (
    requires?.skills.some((requirement) => !requirement.skills || requirement.skills.length === 0)
  ) {
    return [];
  }
  const sourced = new Set(
    requires?.skills.flatMap((requirement) => requirement.skills ?? []) ?? [],
  );
  return missingSkillNames.filter((name) => !sourced.has(name));
}

export interface DigitalHumanSkillEntry {
  name: string;
  description: string;
  source: "project" | "user" | "plugin" | "panel-app";
  /** Omitted by legacy callers; false means installed but disabled by settings. */
  enabled?: boolean;
}

export function digitalHumanNamedProjectRequirementSkillNames(
  requires: DigitalHumanProfileEntry["requires"],
): Set<string> {
  return new Set(requires?.skills.flatMap((requirement) => requirement.skills ?? []) ?? []);
}

export function hasDigitalHumanCatchAllSkillRequirement(
  requires: DigitalHumanProfileEntry["requires"],
): boolean {
  return Boolean(
    requires?.skills.some((requirement) => !requirement.skills || requirement.skills.length === 0),
  );
}

/**
 * A named requirement installs into the project and is only satisfied by that
 * project-scoped copy. Other configured Skills may come from any visible
 * source. This mirrors core's requirement planner so the UI cannot say "ready"
 * immediately before summon asks to install.
 */
export function digitalHumanMissingSkillNames(
  configuredSkillNames: readonly string[],
  requires: DigitalHumanProfileEntry["requires"],
  availableSkills: readonly DigitalHumanSkillEntry[],
): string[] {
  const anyInstalled = new Set(availableSkills.map((skill) => skill.name));
  const projectInstalled = new Set(
    availableSkills.filter((skill) => skill.source === "project").map((skill) => skill.name),
  );
  const namedProjectRequirements = digitalHumanNamedProjectRequirementSkillNames(requires);
  return configuredSkillNames.filter((name) =>
    namedProjectRequirements.has(name) ? !projectInstalled.has(name) : !anyInstalled.has(name),
  );
}

export interface DigitalHumanCatalogEntry extends Omit<DigitalHumanProfileEntry, "active"> {
  category: "product" | "design" | "engineering" | "quality";
  tags: string[];
  samplePrompts: string[];
  /** Set when the entry came from a registered digital-human repo. */
  sourceRepo?: string;
  installed: boolean;
}

export interface CuratedDigitalHumanTeam {
  id: string;
  name: string;
  description: string;
  category: DigitalHumanCatalogEntry["category"];
  tags: string[];
  members: string[];
  mode: DigitalHumanTeamMode;
  samplePrompts: string[];
}
