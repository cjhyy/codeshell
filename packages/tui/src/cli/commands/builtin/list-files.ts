import { execFileSync } from "node:child_process";

/**
 * List files under `cwd` via `find`, run with an argv array (no shell) so a
 * user-supplied glob `pattern` can never be interpreted as shell syntax. The
 * `/files` command used to build a `find ... -name "${pattern}"` shell string
 * with execSync and interpolate raw user input — a command injection
 * (review-2026-05-30). Here `pattern` is one literal `-name` value.
 *
 * Output is capped to 50 lines in JS (the old `| head -50` needed a shell).
 * Errors surface as an empty string for the caller to handle.
 */
const MAX_LINES = 50;
const PRUNE = [
  "-not", "-path", "*/node_modules/*",
  "-not", "-path", "*/.git/*",
];

export function listFiles(cwd: string, pattern: string): string {
  const args = pattern
    ? [".", "-maxdepth", "3", "-name", pattern, ...PRUNE]
    : [".", "-maxdepth", "2", "-type", "f", ...PRUNE, "-not", "-path", "*/dist/*"];
  let out: string;
  try {
    out = execFileSync("find", args, { cwd, encoding: "utf-8", timeout: 10_000 });
  } catch {
    return "";
  }
  return out
    .split("\n")
    .filter((l) => l.trim())
    .slice(0, MAX_LINES)
    .join("\n");
}
