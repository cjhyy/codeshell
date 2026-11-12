import {
  joinContextListParts,
  type ContextListParts,
  type ContextSectionItem,
} from "../../context/context-ledger.js";
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
  const words = normalized.match(/[\p{L}\p{N}_+#.-]+/gu) ?? [];
  return [
    ...new Set(
      words.flatMap((word) => {
        if (
          !/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(
            word,
          ) ||
          word.length < 2
        )
          return [word];
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
  const budget = context * 0.01;
  const requested = options.maxTokens ?? budget;
  return Number.isFinite(budget) && Number.isFinite(requested)
    ? Math.max(0, Math.min(2_048, Math.floor(budget), Math.floor(requested)))
    : 0;
}

const UNGROUPED = "用户 / 项目";

/**
 * The listing as header + one item per line + footer, so a caller can report a
 * single added or changed skill. Skill rows are identified by skill name;
 * group headings and the blank lines between groups are structural. Null when
 * no listing fits the budget (or there are no skills).
 */
export function buildSkillListingParts(
  skills: readonly SkillDefinition[],
  options: SkillListingOptions = {},
): ContextListParts | null {
  if (skills.length === 0) return null;
  const budget = skillListingBudget(options);
  const ranked = rankSkillsForDiscovery(skills, options);
  const selected = new Map<SkillDefinition, string>();
  const parts = (): ContextListParts => {
    const groups = new Map<string, ContextSectionItem[]>();
    for (const [skill, description] of [...selected].sort(([a], [b]) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const colon = skill.name.indexOf(":");
      const group = colon > 0 ? skill.name.slice(0, colon) : UNGROUPED;
      const rows = groups.get(group) ?? [];
      rows.push({
        id: skill.name,
        text: `- ${skill.name}:${description ? ` ${description}` : ""}`,
      });
      groups.set(group, rows);
    }
    const items: ContextSectionItem[] = [];
    for (const [group, rows] of [...groups].sort(([a], [b]) =>
      a === UNGROUPED ? -1 : b === UNGROUPED ? 1 : a < b ? -1 : a > b ? 1 : 0,
    )) {
      if (items.length > 0) items.push({ id: `--- ${group}`, text: "", structural: true });
      items.push({ id: `## ${group}`, text: `## ${group} (${rows.length})`, structural: true });
      items.push(...rows);
    }
    const omitted = skills.length - selected.size;
    return {
      header: "# Available Skills\n\n",
      items,
      footer: `${items.length > 0 ? "\n\n" : ""}${omitted ? `${omitted} more skills omitted. ` : ""}Use Skill({query: "keywords"}) to search metadata, then Skill({skill: "exact-name"}) to load instructions.`,
    };
  };
  const fits = (): boolean => estimateStringTokens(joinContextListParts(parts())) <= budget;
  if (!fits()) return null;
  // Names first preserve broad discovery; expand descriptions in priority order.
  for (const skill of ranked) {
    selected.set(skill, "");
    if (!fits()) selected.delete(skill);
  }
  for (const skill of ranked) {
    if (!selected.has(skill)) continue;
    const description = skillMetadataText(skill.description);
    for (const text of [description, skillMetadataText(description, 160)]) {
      selected.set(skill, text);
      if (fits()) break;
      selected.set(skill, "");
    }
  }
  const result = parts();
  return estimateStringTokens(joinContextListParts(result)) <= budget ? result : null;
}

/** Budget includes headings and discovery guidance. Bodies remain on demand. */
export function buildSkillListing(
  skills: readonly SkillDefinition[],
  options: SkillListingOptions = {},
): string {
  const parts = buildSkillListingParts(skills, options);
  return parts === null ? "" : joinContextListParts(parts);
}

/** Read-only metadata discovery with the same scanner visibility as invocation. */
export function searchSkillMetadata(
  skills: readonly SkillDefinition[],
  query: string,
  offset = 0,
  limit = 10,
): string {
  const queryTerms = terms(query);
  const normalizedQuery = skillMetadataText(query, 1_024).toLowerCase();
  const matching = skills.filter((skill) => {
    const metadata = `${skill.name} ${skillMetadataText(skill.description)}`.toLowerCase();
    return (
      normalizedQuery.length === 0 ||
      (queryTerms.length > 0
        ? queryTerms.some((term) => metadata.includes(term))
        : metadata.includes(normalizedQuery))
    );
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
