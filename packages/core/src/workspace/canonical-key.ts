import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, parse, resolve } from "node:path";

const CASE_INSENSITIVE_PLATFORM = process.platform === "darwin" || process.platform === "win32";

/**
 * Resolve a path through symlinks without requiring the leaf to exist.
 * Missing suffixes are appended to the nearest existing realpathed ancestor.
 */
export function canonicalPath(input: string): string {
  const absolute = isAbsolute(input) ? resolve(input) : resolve(process.cwd(), input);
  let candidate = absolute;
  const suffix: string[] = [];

  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const existing = realpathSync(candidate);
      const joined = suffix.length > 0 ? resolve(existing, ...suffix) : resolve(existing);
      return trimTrailingSeparators(joined);
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return trimTrailingSeparators(absolute);
      suffix.unshift(basename(candidate));
      candidate = parent;
    }
  }

  return trimTrailingSeparators(absolute);
}

/** Stable comparison key for project roots and workspace containment decisions. */
export function canonicalKey(input: string): string {
  const normalized = canonicalPath(input);
  return CASE_INSENSITIVE_PLATFORM ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function trimTrailingSeparators(input: string): string {
  const root = parse(input).root;
  let end = input.length;
  while (end > root.length && (input[end - 1] === "/" || input[end - 1] === "\\")) end -= 1;
  return input.slice(0, end);
}
