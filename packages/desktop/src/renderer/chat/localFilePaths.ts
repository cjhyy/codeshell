export const MAX_LOCAL_FILE_PATHS = 8;

/**
 * Keep user-selected local references literal and bounded. A local path is
 * context, not proof that the app or model successfully read the file.
 */
export function normalizeLocalFilePaths(paths: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const path of paths) {
    if (
      typeof path !== "string" ||
      !path.trim() ||
      path.length > 4_096 ||
      /[\u0000-\u001f\u007f]/u.test(path) ||
      !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(path)
    ) {
      continue;
    }
    unique.add(path);
    if (unique.size >= MAX_LOCAL_FILE_PATHS) break;
  }
  return [...unique];
}

export function localFileBasename(path: string): string {
  return (
    path
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .at(-1) || path
  );
}

/** Append exact JSON-quoted paths so spaces, quotes, and slashes stay unambiguous. */
export function buildMessageWithLocalFilePaths(
  message: string,
  paths: readonly string[],
  label: string,
): string {
  const normalized = normalizeLocalFilePaths(paths);
  const text = message.trim();
  if (normalized.length === 0) return text;
  const pathBlock = `${label}:\n${normalized.map((path) => `- ${JSON.stringify(path)}`).join("\n")}`;
  return text ? `${text}\n\n${pathBlock}` : pathBlock;
}

export function pathForRendererFile(file: File): string | null {
  try {
    const path = window.codeshell.getPathForFile(file);
    if (path) return path;
  } catch {
    // Compatibility with an already-running older preload during HMR.
  }
  const legacyPath = (file as File & { path?: string }).path;
  return legacyPath || null;
}
