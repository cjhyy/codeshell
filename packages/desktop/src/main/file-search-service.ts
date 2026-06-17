/**
 * File search for the @-mention popover in the composer.
 *
 * Two list strategies, chosen per repo:
 *   1. `git ls-files` when cwd is inside a git repo — respects .gitignore
 *      automatically, fast on huge trees.
 *   2. Recursive `fs.readdir` walk with a small ignore list (node_modules,
 *      .git, dist, build) as a fallback for non-git folders.
 *
 * The full file list is cached per-cwd for 15 seconds so successive
 * keystrokes after `@` don't re-walk the tree. Matching is a cheap
 * subsequence fuzzy filter scored by match position + filename hit.
 */
import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join, relative, sep, basename } from "node:path";

export interface FileSearchHit {
  /** Path relative to cwd (forward-slashes). */
  path: string;
  /** Just the basename, for display weight. */
  name: string;
}

interface CacheEntry {
  files: string[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 15_000;
const MAX_HITS = 30;
const cache = new Map<string, CacheEntry>();

function normalize(p: string): string {
  return sep === "\\" ? p.replace(/\\/g, "/") : p;
}

const GIT_LS_TIMEOUT_MS = 5_000;

async function listViaGit(cwd: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    const proc = spawn("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd,
      windowsHide: true,
    });
    let out = "";
    let settled = false;
    const done = (value: string[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // Without a timeout a hung git (huge repo, FS stall, credential prompt)
    // would leave this Promise pending forever — the @-mention search hangs and
    // the git process leaks. Kill it and fall back to the directory walk.
    const timer = setTimeout(() => {
      proc.kill();
      done(null);
    }, GIT_LS_TIMEOUT_MS);
    proc.stdout.on("data", (b: Buffer) => { out += b.toString("utf8"); });
    proc.stderr.on("data", () => { /* drained to avoid backpressure */ });
    proc.on("error", () => done(null));
    proc.on("close", (code) => {
      if (code !== 0) { done(null); return; }
      const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
      done(lines);
    });
  });
}

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  ".cache",
  "coverage",
  ".vscode",
  ".idea",
]);
const MAX_WALK_FILES = 20_000;

async function listViaWalk(cwd: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (found.length >= MAX_WALK_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_WALK_FILES) return;
      if (entry.name.startsWith(".") && entry.name !== ".env") {
        // skip dotfiles/dirs except .env-style which users do mention
        if (entry.isDirectory()) continue;
      }
      if (IGNORE_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        found.push(normalize(relative(cwd, full)));
      }
    }
  }
  await walk(cwd);
  return found;
}

async function loadFileList(cwd: string): Promise<string[]> {
  const now = Date.now();
  const cached = cache.get(cwd);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.files;

  // git ls-files is the fast path; both tracked and untracked-not-ignored.
  let files = await listViaGit(cwd);
  if (!files) {
    try {
      const st = await stat(cwd);
      if (!st.isDirectory()) return [];
    } catch {
      return [];
    }
    files = await listViaWalk(cwd);
  }
  cache.set(cwd, { files, fetchedAt: now });
  return files;
}

/**
 * Subsequence fuzzy match. Returns a score (lower = better) or null.
 * Matches in the basename are preferred over directory hits.
 */
function fuzzyScore(query: string, candidate: string): number | null {
  if (!query) return candidate.length; // any file ranks by path length when no query
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();

  // Cheap substring win — common case ("App.tsx").
  const idx = c.indexOf(q);
  if (idx !== -1) {
    const base = basename(c);
    const baseIdx = base.indexOf(q);
    // Big bonus when the substring lands in the basename.
    const baseBonus = baseIdx !== -1 ? -200 + baseIdx : 0;
    return idx + candidate.length / 1000 + baseBonus;
  }

  // Fall back to subsequence — every char of q in order in c.
  let ci = 0;
  let last = -1;
  let score = 0;
  for (const ch of q) {
    const found = c.indexOf(ch, ci);
    if (found === -1) return null;
    score += found - last;
    last = found;
    ci = found + 1;
  }
  return score + candidate.length / 1000;
}

export async function searchFiles(cwd: string, query: string): Promise<FileSearchHit[]> {
  if (!cwd || typeof cwd !== "string") return [];
  const files = await loadFileList(cwd);
  const q = query.trim();
  const scored: { path: string; score: number }[] = [];
  for (const f of files) {
    const s = fuzzyScore(q, f);
    if (s !== null) scored.push({ path: f, score: s });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, MAX_HITS).map((h) => ({ path: h.path, name: basename(h.path) }));
}
