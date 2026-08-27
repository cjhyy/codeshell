/** Small display formatters shared by the session/room lists. */
import { translate } from "../i18n/translate.js";
import { loadUILanguage, type UILanguage } from "./uiLanguage.js";

/** Last path segment of a cwd ("/Users/x/proj" → "proj"). Empty for ""/root. */
export function basename(p: string): string {
  if (!p) return "";
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] ?? "";
}

function normalizePath(p: string): string {
  const normalized = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized === "" ? "/" : normalized;
}

function isSameOrInside(cwd: string, root: string): boolean {
  const target = normalizePath(cwd).toLowerCase();
  const base = normalizePath(root).toLowerCase();
  return target === base || target.startsWith(`${base}/`);
}

interface ProjectPathLike {
  id?: string;
  path: string;
  name: string;
  roots?: Array<{ path: string }>;
}

/** Return the desktop project whose V2 root owns `cwd` (longest prefix wins). */
export function projectForCwd<T extends ProjectPathLike>(
  cwd: string | null | undefined,
  projects: T[] = [],
): T | undefined {
  if (!cwd) return undefined;
  let best: T | undefined;
  let bestLen = -1;
  for (const p of projects) {
    const roots = p.roots?.length ? p.roots.map((root) => root.path) : [p.path];
    for (const root of roots) {
      if (!root || !isSameOrInside(cwd, root)) continue;
      const len = normalizePath(root).length;
      if (len > bestLen) {
        best = p;
        bestLen = len;
      }
    }
  }
  return best;
}

/** Group items by their cwd (project). When desktop project order is provided
 *  it wins; unknown projects fall back to newest-first. Empty cwd → "无项目"
 *  bucket, sorted last. Generic over any item carrying `cwd` + `updatedAt`. */
export function groupByProject<T extends { cwd: string; updatedAt: number }>(
  items: T[],
  projects: ProjectPathLike[] = [],
  lang: UILanguage = loadUILanguage(),
): { cwd: string; projectId?: string; name: string; items: T[]; updatedAt: number }[] {
  const map = new Map<string, T[]>();
  for (const it of items) {
    const project = projectForCwd(it.cwd, projects);
    const key = project ? `project:${project.id ?? project.path}` : `cwd:${it.cwd ?? ""}`;
    const arr = map.get(key);
    if (arr) arr.push(it);
    else map.set(key, [it]);
  }
  const projectByKey = new Map(
    projects.map((project, order) => [`project:${project.id ?? project.path}`, { project, order }]),
  );
  const groups = [...map.entries()].map(([key, list]) => {
    const projectEntry = projectByKey.get(key);
    const cwd = projectEntry?.project.path ?? key.slice("cwd:".length);
    return {
      cwd,
      ...(projectEntry?.project.id ? { projectId: projectEntry.project.id } : {}),
      name: cwd
        ? projectEntry?.project.name || basename(cwd) || cwd
        : translate(lang, "mobile.format.noProject"),
      items: list,
      updatedAt: Math.max(...list.map((i) => i.updatedAt)),
      order: projectEntry?.order,
    };
  });
  groups.sort((a, b) => {
    if (!a.cwd && b.cwd) return 1; // 无项目 sinks to bottom
    if (a.cwd && !b.cwd) return -1;
    const ao = a.order;
    const bo = b.order;
    if (ao !== undefined && bo !== undefined && ao !== bo) return ao - bo;
    if (ao !== undefined && bo === undefined) return -1;
    if (ao === undefined && bo !== undefined) return 1;
    return b.updatedAt - a.updatedAt; // newest project first
  });
  return groups.map(({ order: _order, ...group }) => group);
}

/** Coarse relative time ("刚刚" / "5 分钟前" / "3 小时前" / "2 天前").
 *  `now` is injectable for deterministic tests. */
export function relativeTime(
  ts: number,
  now: number = Date.now(),
  lang: UILanguage = loadUILanguage(),
): string {
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return translate(lang, "mobile.format.justNow");
  const min = Math.floor(sec / 60);
  if (min < 60) return translate(lang, "mobile.format.minutesAgo", { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return translate(lang, "mobile.format.hoursAgo", { n: hr });
  const day = Math.floor(hr / 24);
  if (day < 30) return translate(lang, "mobile.format.daysAgo", { n: day });
  const mon = Math.floor(day / 30);
  if (mon < 12) return translate(lang, "mobile.format.monthsAgo", { n: mon });
  return translate(lang, "mobile.format.yearsAgo", { n: Math.floor(mon / 12) });
}
