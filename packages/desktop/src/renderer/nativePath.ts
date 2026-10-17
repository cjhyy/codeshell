/** Native file display paths use the platform supplied by preload, never the browser UA.
 * Unknown platforms keep POSIX semantics: a backslash can be a real filename character.
 * These helpers do not resolve paths or grant file access.
 */
function isSeparator(char: string | undefined, platform: string | undefined): boolean {
  return char === "/" || (platform === "win32" && char === "\\");
}

function rootLength(path: string, platform: string | undefined): number {
  if (platform !== "win32") return path.startsWith("/") ? 1 : 0;
  if (/^[A-Za-z]:/.test(path)) return isSeparator(path[2], platform) ? 3 : 2;
  if (!isSeparator(path[0], platform)) return 0;
  if (isSeparator(path[1], platform)) {
    // A UNC server/share is a root; dirname must not strip its share component.
    let end = 2;
    while (end < path.length && !isSeparator(path[end], platform)) end += 1;
    if (end > 2 && isSeparator(path[end], platform)) {
      const share = end + 1;
      end = share;
      while (end < path.length && !isSeparator(path[end], platform)) end += 1;
      if (end > share) return end;
    }
  }
  return 1;
}

export function nativeBasename(path: string, platform?: string): string {
  const drive = platform === "win32" && /^[A-Za-z]:/.test(path) ? 2 : 0;
  let end = path.length;
  while (end > drive && isSeparator(path[end - 1], platform)) end -= 1;
  let start = end;
  while (start > drive && !isSeparator(path[start - 1], platform)) start -= 1;
  return path.slice(start, end);
}

export function nativeDirname(path: string, platform?: string): string {
  const root = rootLength(path, platform);
  let end = path.length;
  while (end > root && isSeparator(path[end - 1], platform)) end -= 1;
  let separator = end - 1;
  while (separator >= root && !isSeparator(path[separator], platform)) separator -= 1;
  if (separator < root) return root > 0 ? path.slice(0, root) : ".";
  while (separator > root && isSeparator(path[separator - 1], platform)) separator -= 1;
  return path.slice(0, separator);
}
