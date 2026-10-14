/**
 * Plugin variable rewriter.
 *
 * After a plugin is materialized into the cache dir, walk its files and
 * rewrite Claude-specific plugin environment variables to CodeShell-native
 * names:
 *
 * - `CLAUDE_PLUGIN_ROOT` → `CODESHELL_PLUGIN_ROOT`
 * - `CLAUDE_PLUGIN_DATA` → `CODESHELL_PLUGIN_DATA`
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

import { lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REWRITES = [
  ["CLAUDE_PLUGIN_ROOT", "CODESHELL_PLUGIN_ROOT"],
  ["CLAUDE_PLUGIN_DATA", "CODESHELL_PLUGIN_DATA"],
] as const;

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

function walkAndRewrite(
  dir: string,
  summary: RewriteSummary,
  canonicalComposerSvg: string | undefined,
): void {
  let entries: {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }[];
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
      walkAndRewrite(full, summary, canonicalComposerSvg);
      continue;
    }
    if (!ent.isFile()) continue;
    // This installer-owned image is already validated and byte-preserved.
    // Its SVG IDs are image data, not hook/script environment templates.
    if (full === canonicalComposerSvg) continue;

    let raw: Buffer;
    try {
      raw = readFileSync(full);
    } catch {
      continue;
    }
    summary.filesScanned += 1;
    if (isLikelyBinary(raw)) continue;

    const text = raw.toString("utf8");
    let rewritten = text;
    for (const [from, to] of REWRITES) {
      rewritten = rewritten.split(from).join(to);
    }
    if (rewritten === text) continue;
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
 * Rewrite Claude-specific plugin environment variables under `installPath`,
 * then drop a breadcrumb file at the root.
 *
 * Idempotent: re-running on an already-rewritten tree is a no-op for the
 * rewrite but refreshes the breadcrumb's timestamp so the user can see when
 * the most recent install/update ran.
 */
export function rewritePluginVars(installPath: string): RewriteSummary {
  const summary: RewriteSummary = {
    filesScanned: 0,
    filesRewritten: 0,
    rewrittenPaths: [],
  };
  try {
    if (!statSync(installPath).isDirectory()) return summary;
  } catch {
    return summary;
  }

  let canonicalComposerSvg: string | undefined;
  try {
    const manifestPath = join(installPath, ".cs-plugin-manifest.json");
    const info = lstatSync(manifestPath);
    if (info.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024) {
      const bytes = readFileSync(manifestPath);
      if (bytes.length <= 1024 * 1024) {
        const manifest = JSON.parse(bytes.toString("utf8"));
        if (manifest?.interface?.composerIcon === ".cs-plugin-assets/composer-icon.svg") {
          canonicalComposerSvg = join(installPath, ".cs-plugin-assets", "composer-icon.svg");
        }
      }
    }
  } catch {
    // Standalone/raw-source rewriting has no normalized image declaration.
  }
  walkAndRewrite(installPath, summary, canonicalComposerSvg);

  const breadcrumb = {
    rewrittenAt: new Date().toISOString(),
    // Keep the original fields for older tooling that reads this breadcrumb.
    from: REWRITES[0][0],
    to: REWRITES[0][1],
    rewrites: REWRITES.map(([from, to]) => ({ from, to })),
    filesScanned: summary.filesScanned,
    filesRewritten: summary.filesRewritten,
    note:
      "codeshell rewrote Claude-specific plugin environment placeholders to codeshell-native names at install time. " +
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
