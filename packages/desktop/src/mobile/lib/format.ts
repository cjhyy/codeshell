/** Small display formatters shared by the session/room lists. */

/** Last path segment of a cwd ("/Users/x/proj" → "proj"). Empty for ""/root. */
export function basename(p: string): string {
  if (!p) return "";
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] ?? "";
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
