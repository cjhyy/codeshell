/** Group configured connections for display without changing their identity or labels. */
export function groupModelOptions<T extends { provider: string }>(options: readonly T[]) {
  const groups = new Map<string, { provider: string; options: T[] }>();
  for (const option of options) {
    let group = groups.get(option.provider);
    if (!group) {
      group = { provider: option.provider, options: [] };
      groups.set(option.provider, group);
    }
    group.options.push(option);
  }
  return [...groups.values()];
}
