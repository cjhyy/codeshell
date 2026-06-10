/** Small display formatters shared by the session/room lists. */

/** Last path segment of a cwd ("/Users/x/proj" → "proj"). Empty for ""/root. */
export function basename(p: string): string {
  if (!p) return "";
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] ?? "";
}

/** Group items by their cwd (project), newest project first; each group keeps
 *  its incoming item order. Empty cwd → "无项目" bucket, sorted last. Generic
 *  over any item carrying `cwd` + `updatedAt`. */
export function groupByProject<T extends { cwd: string; updatedAt: number }>(
  items: T[],
): { cwd: string; name: string; items: T[]; updatedAt: number }[] {
  const map = new Map<string, T[]>();
  for (const it of items) {
    const key = it.cwd || "";
    const arr = map.get(key);
    if (arr) arr.push(it);
    else map.set(key, [it]);
  }
  const groups = [...map.entries()].map(([cwd, list]) => ({
    cwd,
    name: cwd ? basename(cwd) || cwd : "无项目",
    items: list,
    updatedAt: Math.max(...list.map((i) => i.updatedAt)),
  }));
  groups.sort((a, b) => {
    if (!a.cwd && b.cwd) return 1; // 无项目 sinks to bottom
    if (a.cwd && !b.cwd) return -1;
    return b.updatedAt - a.updatedAt; // newest project first
  });
  return groups;
}

/** Coarse relative time ("刚刚" / "5 分钟前" / "3 小时前" / "2 天前").
 *  `now` is injectable for deterministic tests. */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon} 个月前`;
  return `${Math.floor(mon / 12)} 年前`;
}
