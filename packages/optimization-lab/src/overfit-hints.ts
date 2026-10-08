/** Advisory only: these deterministic, bounded hints never change verdicts or ranking. */
export function overfitHints(
  original: string,
  candidate: string,
  devInputs: string[],
  objective = "",
): string[] {
  const source = devInputs.join("\n").slice(0, 256 * 1024);
  const inspected = candidate.slice(0, 64 * 1024);
  const hints = new Set<string>();
  let probes = 0;
  const add = (fragment: string, kind: string) => {
    if (hints.size >= 32 || probes++ >= 2048 || fragment.length > 120) return;
    if (
      !original.includes(fragment) &&
      !objective.includes(fragment) &&
      source.includes(fragment)
    ) {
      hints.add(`${kind}: ${fragment}`);
    }
  };
  const entities =
    inspected.match(/\b\d+(?:\.\d+)?\b|\b[A-Z][\w-]{3,}\b|\b[\w-]+\.[a-z]{2,8}\b/g) ?? [];
  for (const entity of entities) add(entity, "Development-specific token added");
  // Fixed windows also cover unsegmented Chinese. Shared phrases are only hints.
  for (const run of inspected.match(/[\p{Script=Han}]{7,}/gu) ?? []) {
    for (let index = 0; index + 7 <= run.length && probes < 2048 && hints.size < 32; index++) {
      add(run.slice(index, index + 7), "Development input fragment repeated");
    }
  }
  const words = inspected.split(/\s+/u);
  for (let i = 0; i + 8 <= words.length && probes < 2048 && hints.size < 32; i++) {
    const fragment = words.slice(i, i + 8).join(" ");
    if (fragment.length >= 35) add(fragment, "Development input fragment repeated");
  }
  return [...hints].sort();
}
