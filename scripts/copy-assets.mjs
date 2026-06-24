#!/usr/bin/env node
/**
 * Cross-platform asset copy for build scripts (replaces `mkdir -p` + `cp` which
 * don't exist on Windows cmd.exe). Copies files matching simple patterns into a
 * dest dir, creating it recursively.
 *
 * Usage:
 *   node scripts/copy-assets.mjs <destDir> <srcGlobOrDir> [<srcGlobOrDir> ...]
 *
 * Each src arg is either:
 *   - a directory  → copied recursively into destDir (dir-to-dir)
 *   - a glob like  `src/foo/*.md` → every matching file copied flat into destDir
 *   - a plain file → copied into destDir
 *
 * Run from the package dir whose package.json invokes it (cwd-relative paths).
 */
import { cpSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const [, , destDir, ...srcs] = process.argv;
if (!destDir || srcs.length === 0) {
  console.error("usage: copy-assets.mjs <destDir> <src> [<src> ...]");
  process.exit(2);
}

mkdirSync(destDir, { recursive: true });

for (const src of srcs) {
  const star = src.indexOf("*");
  if (star === -1) {
    // plain file or directory
    let isDir = false;
    try {
      isDir = statSync(src).isDirectory();
    } catch {
      console.error(`copy-assets: source not found: ${src}`);
      process.exit(1);
    }
    // dir → dir/<name> (mirrors `cp -r dir destParent/`); file → destDir/<name>
    const target = join(destDir, basename(src));
    cpSync(src, target, { recursive: true });
  } else {
    // glob like "src/prompt/sections/*.md" — only a trailing "*.<ext>" segment
    const dir = dirname(src);
    const pat = basename(src); // e.g. "*.md"
    const ext = pat.startsWith("*") ? pat.slice(1) : pat; // ".md"
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(ext));
    } catch {
      console.error(`copy-assets: source dir not found: ${dir}`);
      process.exit(1);
    }
    for (const f of files) cpSync(join(dir, f), join(destDir, f));
  }
}
