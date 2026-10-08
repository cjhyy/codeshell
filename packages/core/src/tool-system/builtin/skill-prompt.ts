import { estimateStringTokens } from "../../context/token-counter.js";
import type { SkillDefinition } from "../../skills/scanner.js";

export interface SkillListingOptions {
  /** Estimated metadata budget: 1% of the context window, capped at 2,048. */
  maxContextTokens?: number;
  maxTokens?: number;
  preferredSkills?: readonly string[];
  declaredSkills?: readonly string[];
  /** Recent requests, most recent first; this does not imply successful execution. */
  recentSkills?: readonly string[];
  task?: string;
}

export function skillMetadataText(text: string, maxLength = 2_048): string {
  return text
    .slice(0, maxLength)
    .replace(/[\u0000-\u001f\u007f\s]+/g, " ")
    .trim();
}

function terms(text: string): string[] {
  const normalized = text.slice(0, 8_192).toLowerCase();
  const words =
    normalized.match(/[a-z0-9_-]{2,}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ??
    [];
  return [
    ...new Set(
      words.flatMap((word) => {
        if (/^[a-z0-9_-]/.test(word) || word.length < 2) return [word];
        return Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2));
      }),
    ),
  ].slice(0, 128);
}

/** Local lexical ranking only; never reads skill bodies or changes visibility. */
export function rankSkillsForDiscovery(
  skills: readonly SkillDefinition[],
  options: SkillListingOptions = {},
): SkillDefinition[] {
  const preferred = new Set(options.preferredSkills);
  const declared = new Set(options.declaredSkills);
  const recent = new Map((options.recentSkills ?? []).map((name, i) => [name, i]));
  const query = terms(options.task ?? "");
  return skills
    .map((skill) => {
      const metadata = `${skill.name} ${skillMetadataText(skill.description)}`.toLowerCase();
      const score = query.reduce((sum, term) => sum + Number(metadata.includes(term)), 0);
      const tier = preferred.has(skill.name)
        ? 0
        : skill.source === "project"
          ? 1
          : declared.has(skill.name)
            ? 2
            : recent.has(skill.name)
              ? 3
              : score > 0
                ? 4
                : skill.source === "user"
                  ? 5
                  : 6;
      return { skill, tier, score, recent: recent.get(skill.name) ?? Number.MAX_SAFE_INTEGER };
    })
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        b.score - a.score ||
        a.recent - b.recent ||
        (a.skill.name < b.skill.name ? -1 : a.skill.name > b.skill.name ? 1 : 0),
    )
    .map(({ skill }) => skill);
}

export function skillListingBudget(options: SkillListingOptions = {}): number {
  const context = options.maxContextTokens ?? 128_000;
  const budget = options.maxTokens ?? context * 0.01;
  return Number.isFinite(budget) ? Math.max(0, Math.min(2_048, Math.floor(budget))) : 0;
}

/** Budget includes headings and discovery guidance. Bodies remain on demand. */
export function buildSkillListing(
  skills: readonly SkillDefinition[],
  options: SkillListingOptions = {},
): string {
  if (skills.length === 0) return "";
  const budget = skillListingBudget(options);
  const ranked = rankSkillsForDiscovery(skills, options);
  const selected = new Map<SkillDefinition, string>();
  const render = (): string => {
    const groups = new Map<string, string[]>();
    for (const [skill, description] of [...selected].sort(([a], [b]) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const colon = skill.name.indexOf(":");
      const group = colon > 0 ? skill.name.slice(0, colon) : "用户 / 项目";
      const rows = groups.get(group) ?? [];
      rows.push(`- ${skill.name}${description ? `: ${description}` : ""}`);
      groups.set(group, rows);
    }
    const sections = [...groups]
      .sort(([a], [b]) =>
        a === "用户 / 项目" ? -1 : b === "用户 / 项目" ? 1 : a < b ? -1 : a > b ? 1 : 0,
      )
      .map(([group, rows]) => `## ${group} (${rows.length})\n${rows.join("\n")}`);
    const omitted = skills.length - selected.size;
    return [
      "# Available Skills",
      ...sections,
      `${omitted ? `${omitted} more skills omitted. ` : ""}Use Skill({query: \"keywords\"}) to search metadata, then Skill({skill: \"exact-name\"}) to load instructions.`,
    ].join("\n\n");
  };
  if (estimateStringTokens(render()) > budget) return "";
  // Names first preserve broad discovery; expand descriptions in priority order.
  for (const skill of ranked) {
    selected.set(skill, "");
    if (estimateStringTokens(render()) > budget) selected.delete(skill);
  }
  for (const skill of ranked) {
    if (!selected.has(skill)) continue;
    const description = skillMetadataText(skill.description);
    for (const text of [description, skillMetadataText(description, 160)]) {
      selected.set(skill, text);
      if (estimateStringTokens(render()) <= budget) break;
      selected.set(skill, "");
    }
  }
  const result = render();
  return estimateStringTokens(result) <= budget ? result : "";
}

/** Read-only metadata discovery with the same scanner visibility as invocation. */
export function searchSkillMetadata(
  skills: readonly SkillDefinition[],
  query: string,
  offset = 0,
  limit = 10,
): string {
  const queryTerms = terms(query);
  const matching = skills.filter((skill) => {
    const metadata = `${skill.name} ${skillMetadataText(skill.description)}`.toLowerCase();
    return queryTerms.length === 0 || queryTerms.some((term) => metadata.includes(term));
  });
  const ranked = rankSkillsForDiscovery(matching, { task: query });
  const results: { name: string; description: string; source: SkillDefinition["source"] }[] = [];
  for (const skill of ranked.slice(offset, offset + limit)) {
    const row = {
      name: skill.name,
      description: skillMetadataText(skill.description, 320),
      source: skill.source,
    };
    if (JSON.stringify([...results, row]).length > 6_144) break;
    results.push(row);
  }
  const nextOffset = offset + results.length;
  return JSON.stringify({
    results,
    total: ranked.length,
    nextOffset: nextOffset < ranked.length && results.length > 0 ? nextOffset : null,
  });
}
