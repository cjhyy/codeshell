export interface RepoLike {
  id: string;
  name: string;
  path: string;
}

/** True on platforms whose filesystems are case-insensitive by default. */
export function isCaseInsensitivePlatform(): boolean {
  const p =
    typeof navigator !== "undefined" && typeof navigator.platform === "string"
      ? navigator.platform.toLowerCase()
      : "";
  // darwin ("MacIntel"/"MacARM") + windows ("Win32") → case-insensitive.
  // Linux ("Linux x86_64") → case-sensitive. Unknown → insensitive (safer:
  // we'd rather over-match an existing repo than wrongly auto-create one).
  if (p.includes("mac") || p.includes("win")) return true;
  if (p.includes("linux")) return false;
  return true;
}

/** Strip trailing slashes (keep a lone "/") and optionally lowercase. */
export function normalizeCwd(cwd: string, caseInsensitive: boolean): string {
  let out = cwd.replace(/\/+$/, "");
  if (out === "") out = "/";
  return caseInsensitive ? out.toLowerCase() : out;
}

/** Return the id of the repo whose path equals `cwd` (normalized), or null. */
export function matchRepoIdForCwd(
  cwd: string,
  repos: RepoLike[],
  caseInsensitive: boolean,
): string | null {
  const target = normalizeCwd(cwd, caseInsensitive);
  for (const r of repos) {
    if (normalizeCwd(r.path, caseInsensitive) === target) return r.id;
  }
  return null;
}
