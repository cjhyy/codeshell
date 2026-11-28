/**
 * Mimi rescans recent Claude Code / Codex sessions every few seconds, and each
 * card title comes from a bounded read of up to 1 MiB per session. A
 * session's first user message never changes once written, so the title is
 * reused while the file keeps its inode. An empty title is not cached: the
 * first prompt may not have been written yet.
 */
const titles = new Map<string, { ino: number; title: string }>();
const MAX_TITLES = 1_000;

export function cachedSessionTitle(file: string, ino: number, read: () => string): string {
  const hit = titles.get(file);
  if (hit && hit.ino === ino) return hit.title;
  const title = read();
  titles.delete(file);
  if (title) {
    titles.set(file, { ino, title });
    if (titles.size > MAX_TITLES) titles.delete(titles.keys().next().value!);
  }
  return title;
}
