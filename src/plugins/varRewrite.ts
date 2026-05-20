/**
 * Plugin variable rewriter.
 *
 * After a plugin is materialized into the cache dir, walk its files and
 * rewrite every occurrence of `CLAUDE_PLUGIN_ROOT` to `CODESHELL_PLUGIN_ROOT`.
 *
 * Why: plugins authored against Claude Code's protocol embed
 * `${CLAUDE_PLUGIN_ROOT}` in their hooks.json command strings and inside
 * shell scripts. codeshell uses its own env var name (`CODESHELL_PLUGIN_ROOT`)
 * to keep plugin-side host detection unambiguous — so we rewrite the file
 * tree at install time once, instead of dual-setting env vars at every hook
 * invocation (which would let plugins falsely conclude they're running on
 * Claude Code and emit CC-specific output formats).
 *
 * The rewrite is whole-token (not regex with word boundaries — Node's
 * `String.replaceAll` on a literal substring is sufficient because no
 * substring of the source contains the target as a prefix/suffix of another
 * identifier in any plugin we've seen). If a plugin author chose
 * `CLAUDE_PLUGIN_ROOT_SUFFIX` as an identifier this would also get rewritten,
 * but that case is implausible enough we accept the risk over more complex
 * tokenization.
 *
 * Binary files are skipped via NUL-byte heuristic on first 8 KiB.
 *
 * A breadcrumb file (`.code-shell-installed.json`) records the rewrite so
 * a user debugging "why does this file differ from upstream?" has an
 * explanation in-place.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FROM = "CLAUDE_PLUGIN_ROOT";
const TO = "CODESHELL_PLUGIN_ROOT";

const SCAN_BYTES = 8192;

export interface RewriteSummary {
  filesScanned: number;
  filesRewritten: number;
  rewrittenPaths: string[];
}

function isLikelyBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, SCAN_BYTES);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function walkAndRewrite(dir: string, summary: RewriteSummary): void {
  let entries: { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      // Skip VCS metadata: we never want to mutate a plugin's .git internals,
      // even though we don't expect one in a cache dir.
      if (ent.name === ".git") continue;
      walkAndRewrite(full, summary);
      continue;
    }
    if (!ent.isFile()) continue;

    let raw: Buffer;
    try {
      raw = readFileSync(full);
    } catch {
      continue;
    }
    summary.filesScanned += 1;
    if (isLikelyBinary(raw)) continue;

    const text = raw.toString("utf8");
    if (!text.includes(FROM)) continue;

    const rewritten = text.split(FROM).join(TO);
    try {
      writeFileSync(full, rewritten, "utf8");
      summary.filesRewritten += 1;
      summary.rewrittenPaths.push(full);
    } catch {
      // Read-only file (e.g. EACCES on a permissioned drop-in) — log via
      // count but don't crash the install.
    }
  }
}

/**
 * Rewrite every `CLAUDE_PLUGIN_ROOT` → `CODESHELL_PLUGIN_ROOT` under
 * `installPath`, then drop a breadcrumb file at the root.
 *
 * Idempotent: re-running on an already-rewritten tree is a no-op for the
 * rewrite (no `CLAUDE_PLUGIN_ROOT` left) but refreshes the breadcrumb's
 * timestamp so the user can see when the most recent install/update ran.
 */
export function rewritePluginVars(installPath: string): RewriteSummary {
  const summary: RewriteSummary = {
    filesScanned: 0,
    filesRewritten: 0,
    rewrittenPaths: [],
  };
  let exists = false;
  try {
    exists = statSync(installPath).isDirectory();
  } catch {
    exists = false;
  }
  if (!exists) return summary;

  walkAndRewrite(installPath, summary);

  const breadcrumb = {
    rewrittenAt: new Date().toISOString(),
    from: FROM,
    to: TO,
    filesScanned: summary.filesScanned,
    filesRewritten: summary.filesRewritten,
    note:
      "codeshell rewrote plugin files at install time so ${CLAUDE_PLUGIN_ROOT} placeholders use codeshell's native env var. " +
      "Upstream plugin sources are unchanged; only this local copy was modified.",
  };
  try {
    writeFileSync(
      join(installPath, ".code-shell-installed.json"),
      JSON.stringify(breadcrumb, null, 2) + "\n",
      "utf8",
    );
  } catch {
    // Non-fatal — the rewrite already succeeded.
  }

  return summary;
}
