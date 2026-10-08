/** Advisory only: these deterministic hints never change verdicts or ranking. */
export function overfitHints(original: string, candidate: string, devInputs: string[]): string[] {
  const source = devInputs.join("\n");
  const hints = new Set<string>();
  const entities =
    candidate.match(/\b\d+(?:\.\d+)?\b|\b[A-Z][\w-]{3,}\b|\b[\w-]+\.[a-z]{2,8}\b/g) ?? [];
  for (const entity of entities) {
    if (!original.includes(entity) && source.includes(entity))
      hints.add(`Development-specific token added: ${entity}`);
  }
  const words = candidate.split(/\s+/u);
  for (let i = 0; i + 8 <= words.length; i++) {
    const fragment = words.slice(i, i + 8).join(" ");
    if (fragment.length >= 35 && !original.includes(fragment) && source.includes(fragment)) {
      hints.add(`Development input fragment repeated: ${fragment}`);
    }
  }
  return [...hints].sort();
}
