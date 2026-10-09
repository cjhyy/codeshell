/** Single-owner context associations are relevance hints, never authorization. */
export interface PetContextOriginRef {
  id: string;
  kind: "desktop" | "im-gateway" | "unknown";
  channel: string;
}

export interface PetGroundedTaskRef {
  taskId: string;
  sessionId: string;
  objective: string;
}

export interface PetRecallMemory {
  id: string;
  text: string;
  source: "user" | "mimi" | "auto";
  updatedAt: number;
  segmentId?: string;
  originRef?: PetContextOriginRef;
  taskIds?: readonly string[];
}

export interface PetMemoryRecallInput {
  message: string;
  /** Only objectives resolved by the host from existing task identities. */
  groundedObjectives?: readonly string[];
  originRef?: PetContextOriginRef;
  taskIds?: readonly string[];
}

export interface PetMemoryRecallWindow {
  visibleCount: number;
  totalCount: number;
  matchedCount: number;
  truncated: boolean;
  selection: "goal-relevance";
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "please",
  "remember",
  "continue",
  "我的",
  "我们",
  "你们",
  "这个",
  "那个",
  "继续",
  "一下",
  "帮我",
  "请问",
  "什么",
  "记住",
]);

/**
 * Bounded deterministic recall over the whole retained personal-memory library.
 * Matching only orders facts: it never merges, rewrites or grants authority.
 * Chinese bigrams cover unsegmented text without an embedding/model dependency.
 */
export function selectPetMemories<T extends PetRecallMemory>(
  entries: readonly T[],
  input: PetMemoryRecallInput,
  options: { maxEntries?: number; maxChars?: number; recentCount?: number } = {},
): { memories: T[]; memoryWindow: PetMemoryRecallWindow } {
  const maxEntries = boundedInteger(options.maxEntries, 24, 200);
  const maxChars = boundedInteger(options.maxChars, 10_000, 24_000);
  const recentCount = Math.min(boundedInteger(options.recentCount, 4, 24), maxEntries);
  const messageTerms = terms(input.message.slice(0, 4_000));
  const objectiveTerms = terms(
    (input.groundedObjectives ?? []).slice(0, 4).join(" ").slice(0, 3_200),
  );
  const taskIds = new Set((input.taskIds ?? []).slice(0, 20));
  const newest = [...entries].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const ranked = newest
    .map((entry) => {
      const entryTerms = terms(entry.text.slice(0, 2_000));
      const lexical =
        overlap(entryTerms, messageTerms) * 4 + overlap(entryTerms, objectiveTerms) * 2;
      const task = entry.taskIds?.some((id) => taskIds.has(id)) ? 12 : 0;
      // An origin match breaks a relevance tie; it cannot hide global/legacy facts.
      const origin = input.originRef && entry.originRef?.id === input.originRef.id ? 1 : 0;
      return { entry, matched: lexical + task > 0, score: lexical + task + origin };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.entry.updatedAt - a.entry.updatedAt ||
        a.entry.id.localeCompare(b.entry.id),
    );
  const related = ranked.filter((row) => row.matched).map((row) => row.entry);
  const selected: T[] = [];
  const seen = new Set<string>();
  let chars = 2;
  const add = (entry: T) => {
    if (seen.has(entry.id) || selected.length >= maxEntries) return;
    const cost = JSON.stringify(entry).length + (selected.length ? 1 : 0);
    if (chars + cost > maxChars) return;
    seen.add(entry.id);
    selected.push(entry);
    chars += cost;
  };
  // Reserve a few recent facts without letting them displace all relevant old ones.
  for (const entry of related.slice(0, Math.max(1, maxEntries - recentCount))) add(entry);
  for (const entry of newest.slice(0, recentCount)) add(entry);
  for (const entry of [...related, ...newest]) add(entry);
  return {
    memories: selected,
    memoryWindow: {
      visibleCount: selected.length,
      totalCount: entries.length,
      matchedCount: selected.filter((entry) =>
        ranked.some((row) => row.entry.id === entry.id && row.matched),
      ).length,
      truncated: selected.length < entries.length,
      selection: "goal-relevance",
    },
  };
}

function boundedInteger(value: number | undefined, fallback: number, ceiling: number): number {
  return value === undefined
    ? fallback
    : Math.min(ceiling, Math.max(0, Number.isFinite(value) ? Math.floor(value) : fallback));
}

function terms(text: string): Set<string> {
  const result = new Set<string>();
  const normalized = text.normalize("NFKC").toLowerCase();
  for (const token of normalized.match(/[a-z0-9][a-z0-9_.+/-]*|[\p{Script=Han}]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(token)) {
      if (token.length === 1) result.add(token);
      for (let i = 0; i + 1 < token.length; i++) {
        const gram = token.slice(i, i + 2);
        if (!STOP_WORDS.has(gram)) result.add(gram);
        if (result.size >= 256) break;
      }
    } else if (token.length > 1 && !STOP_WORDS.has(token)) result.add(token);
    if (result.size >= 256) break;
  }
  return result;
}

function overlap(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const term of right) if (left.has(term)) count += 1;
  return count;
}
