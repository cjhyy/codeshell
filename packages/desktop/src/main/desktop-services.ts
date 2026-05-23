/**
 * Desktop-side services that don't belong in the agent worker:
 *   - git status / git diff (renderer needs these to render Diff inspector)
 *   - openExternal, revealInFinder (Electron-only file actions)
 *
 * Each function spawns a child process synchronously-ish (via execFile
 * promise) and returns plain data. Errors are normalized to throw a
 * single Error subclass so the renderer can route them uniformly.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { shell } from "electron";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

export interface GitStatusEntry {
  /** XY status code per git porcelain v1 (e.g. " M", "??", "A ", "MM"). */
  code: string;
  path: string;
}

export interface GitStatus {
  branch: string | null;
  entries: GitStatusEntry[];
  clean: boolean;
}

async function gitRun(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024, // 32 MB cap; diffs can be huge
    windowsHide: true,
  });
  return stdout;
}

export async function getGitStatus(cwd: string): Promise<GitStatus> {
  let branch: string | null = null;
  try {
    branch = (await gitRun(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch {
    branch = null;
  }
  let raw = "";
  try {
    raw = await gitRun(cwd, ["status", "--porcelain=v1"]);
  } catch {
    return { branch, entries: [], clean: true };
  }
  const entries: GitStatusEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const p = line.slice(3).trim();
    entries.push({ code, path: p });
  }
  return { branch, entries, clean: entries.length === 0 };
}

/**
 * Unified diff for the working tree (vs HEAD). If `file` is provided,
 * limits to that path. Falls back to staged-only if working tree is
 * clean but index has changes.
 */
export async function getGitDiff(cwd: string, file?: string): Promise<string> {
  const baseArgs = ["diff", "--no-color", "--unified=3"];
  const args = file ? [...baseArgs, "--", file] : baseArgs;
  try {
    const wt = await gitRun(cwd, args);
    if (wt.trim()) return wt;
  } catch {
    // fall through
  }
  try {
    const staged = await gitRun(cwd, [...baseArgs, "--cached", ...(file ? ["--", file] : [])]);
    return staged;
  } catch {
    return "";
  }
}

export async function openExternal(url: string): Promise<void> {
  // Only allow http(s) and file URLs to be opened externally.
  if (!/^(https?:|file:)/i.test(url)) {
    throw new Error(`Refused to open URL with unsupported scheme: ${url}`);
  }
  await shell.openExternal(url);
}

export async function revealInFinder(targetPath: string): Promise<void> {
  const normalized = path.resolve(targetPath);
  shell.showItemInFolder(normalized);
}
