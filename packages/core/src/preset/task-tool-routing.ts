/** Preset-owned schema loading hints. These never grant tool execution authority. */
export interface TaskToolRoutingRule {
  id: string;
  terms: readonly string[];
  toolNames: readonly string[];
}

export interface TaskToolRoutingPolicy {
  managedToolNames: readonly string[];
  coreToolNames: readonly string[];
  rules: readonly TaskToolRoutingRule[];
  minInitialTools?: number;
  maxInitialTools?: number;
}

export interface TaskToolRoutingResult {
  initialToolNames: readonly string[] | undefined;
  reason: "matched" | "no_match" | "invalid_policy" | "legacy";
  matchedRuleIds: readonly string[];
}

const MAX_TASK_CHARACTERS = 16_384;
const MAX_MANAGED_TOOLS = 128;
const MAX_RULES = 32;
const MAX_TERMS_PER_RULE = 32;
const MAX_TOTAL_TERMS = 256;
const MAX_TERM_CHARACTERS = 128;
const MAX_INITIAL_TOOLS = 15;

interface ValidPolicy {
  managed: readonly string[];
  core: readonly string[];
  rules: readonly TaskToolRoutingRule[];
  min: number;
  max: number;
}

function validNames(value: unknown, max: number): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    Array.from(value).every(
      (name) =>
        typeof name === "string" &&
        name.length > 0 &&
        name.length <= 128 &&
        name.trim() === name &&
        !/[\u0000-\u001f\u007f]/u.test(name),
    ) &&
    new Set(value).size === value.length
  );
}

function normalizeTerm(term: string): string {
  return term.normalize("NFKC").toLowerCase();
}

function validatePolicy(policy: TaskToolRoutingPolicy): ValidPolicy | undefined {
  if (!policy || typeof policy !== "object") return undefined;
  const { managedToolNames: managed, coreToolNames: core, rules } = policy;
  const min = policy.minInitialTools ?? 8;
  const max = policy.maxInitialTools ?? MAX_INITIAL_TOOLS;
  if (
    !validNames(managed, MAX_MANAGED_TOOLS) ||
    !validNames(core, MAX_INITIAL_TOOLS) ||
    !Array.isArray(rules) ||
    rules.length > MAX_RULES ||
    !Number.isInteger(min) ||
    !Number.isInteger(max) ||
    min < 8 ||
    max > MAX_INITIAL_TOOLS ||
    min > max ||
    core.length > max
  ) {
    return undefined;
  }
  const managedSet = new Set(managed);
  if (core.some((name) => !managedSet.has(name))) return undefined;
  const ids = new Set<string>();
  let termCount = 0;
  for (const rule of rules) {
    if (
      !rule ||
      typeof rule !== "object" ||
      typeof rule.id !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(rule.id) ||
      ids.has(rule.id) ||
      !validNames(rule.toolNames, MAX_MANAGED_TOOLS) ||
      rule.toolNames.some((name) => !managedSet.has(name)) ||
      !Array.isArray(rule.terms) ||
      rule.terms.length === 0 ||
      rule.terms.length > MAX_TERMS_PER_RULE
    ) {
      return undefined;
    }
    ids.add(rule.id);
    termCount += rule.terms.length;
    if (termCount > MAX_TOTAL_TERMS) return undefined;
    for (const term of rule.terms) {
      if (typeof term !== "string" || term.length === 0 || term.length > MAX_TERM_CHARACTERS) {
        return undefined;
      }
      const normalized = normalizeTerm(term);
      // Literal words/phrases only; preset authors cannot supply a regular expression.
      if (
        normalized.length > MAX_TERM_CHARACTERS ||
        !/^[\p{L}\p{N}]+(?:[ _-][\p{L}\p{N}]+)*$/u.test(normalized)
      ) {
        return undefined;
      }
    }
  }
  return { managed, core, rules, min, max };
}

function containsTerm(text: string, term: string): boolean {
  const asciiWord = (character: string | undefined) =>
    character !== undefined && /[a-z0-9_]/u.test(character);
  let offset = text.indexOf(term);
  while (offset !== -1) {
    const before = text[offset - 1];
    const after = text[offset + term.length];
    if (
      (!asciiWord(term[0]) || !asciiWord(before)) &&
      (!asciiWord(term[term.length - 1]) || !asciiWord(after))
    ) {
      return true;
    }
    offset = text.indexOf(term, offset + 1);
  }
  return false;
}

/** Select once from the complete eligible catalog; no prompt or matched term escapes this call. */
export function routeInitialTools(input: {
  initialToolNames: readonly string[] | undefined;
  eligibleToolNames: readonly string[];
  taskText: string;
  policy?: TaskToolRoutingPolicy;
}): TaskToolRoutingResult {
  const fallback = (reason: TaskToolRoutingResult["reason"]): TaskToolRoutingResult => ({
    initialToolNames: input.initialToolNames,
    reason,
    matchedRuleIds: [],
  });
  if (
    input.initialToolNames === undefined ||
    input.policy === undefined ||
    !input.eligibleToolNames.includes("ToolSearch")
  ) {
    return fallback("legacy");
  }
  const policy = validatePolicy(input.policy);
  if (!policy) return fallback("invalid_policy");
  if (typeof input.taskText !== "string") return fallback("no_match");
  const text = input.taskText
    .slice(0, MAX_TASK_CHARACTERS)
    .normalize("NFKC")
    .toLowerCase()
    .slice(0, MAX_TASK_CHARACTERS);
  const matches = policy.rules
    .map((rule, index) => ({
      rule,
      index,
      score: [...new Set(rule.terms.map(normalizeTerm))].filter((term) => containsTerm(text, term))
        .length,
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  if (matches.length === 0) return fallback("no_match");

  const eligible = new Set(input.eligibleToolNames);
  const selected = new Set<string>();
  const add = (names: readonly string[], limit: number) => {
    for (const name of names) {
      if (selected.size >= limit) break;
      if (eligible.has(name)) selected.add(name);
    }
  };
  // Discovery already belongs to every RunToolSurface; account for it in this budget too.
  add(["ToolSearch", ...policy.core], policy.max);
  for (const { rule } of matches) add(rule.toolNames, policy.max);
  add(policy.managed, Math.max(policy.min, selected.size));

  // Inherited/custom preset additions are not part of the first-party routing budget.
  const managed = new Set(policy.managed);
  const extras = input.initialToolNames.filter(
    (name) => !managed.has(name) && eligible.has(name) && !selected.has(name),
  );
  return {
    initialToolNames: [...selected, ...new Set(extras)],
    reason: "matched",
    matchedRuleIds: matches.map(({ rule }) => rule.id),
  };
}
