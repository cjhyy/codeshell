/**
 * Git utility functions for the git workflow commands.
 */

import { execSync } from "node:child_process";

export interface GitStatusEntry {
  status: string;
  path: string;
}

export interface GitLogEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export function isGitRepo(cwd: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd, encoding: "utf-8", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function getCurrentBranch(cwd: string): string {
  return execSync("git branch --show-current", { cwd, encoding: "utf-8", timeout: 5000 }).trim();
}

export function getGitStatus(cwd: string): GitStatusEntry[] {
  const raw = execSync("git status --porcelain", { cwd, encoding: "utf-8", timeout: 10000 }).trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => ({
    status: line.slice(0, 2).trim(),
    path: line.slice(3),
  }));
}

export function getGitDiff(cwd: string, opts?: { staged?: boolean; file?: string }): string {
  const args = ["git", "diff", "--no-color"];
  if (opts?.staged) args.push("--staged");
  if (opts?.file) args.push("--", opts.file);
  return execSync(args.join(" "), { cwd, encoding: "utf-8", timeout: 30000 }).trim();
}

export function getGitDiffStat(cwd: string, opts?: { staged?: boolean; file?: string }): string {
  const args = ["git", "diff", "--stat", "--no-color"];
  if (opts?.staged) args.push("--staged");
  if (opts?.file) args.push("--", opts.file);
  return execSync(args.join(" "), { cwd, encoding: "utf-8", timeout: 10000 }).trim();
}

export function getGitLog(cwd: string, n = 10): GitLogEntry[] {
  const raw = execSync(
    `git log --oneline --format="%H|%s|%an|%ci" -${n}`,
    { cwd, encoding: "utf-8", timeout: 10000 },
  ).trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => {
    const [hash, message, author, date] = line.split("|");
    return { hash: hash.slice(0, 8), message, author, date };
  });
}

export function getRemoteUrl(cwd: string): string | undefined {
  try {
    return execSync("git remote get-url origin", { cwd, encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    return undefined;
  }
}

export function gitAdd(cwd: string, files: string[] = ["."]): void {
  const fileArgs = files.map((f) => `"${f}"`).join(" ");
  execSync(`git add ${fileArgs}`, { cwd, timeout: 10000 });
}

export function gitCommit(cwd: string, message: string): string {
  return execSync(`git commit -m ${JSON.stringify(message)}`, {
    cwd,
    encoding: "utf-8",
    timeout: 30000,
  }).trim();
}

export function gitListBranches(cwd: string): { name: string; current: boolean }[] {
  const raw = execSync("git branch --no-color", { cwd, encoding: "utf-8", timeout: 5000 }).trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => ({
    current: line.startsWith("*"),
    name: line.replace(/^\*?\s+/, "").trim(),
  }));
}

export function gitCheckout(cwd: string, branch: string, create = false): void {
  const flag = create ? "-b" : "";
  execSync(`git checkout ${flag} ${branch}`, { cwd, timeout: 10000 });
}

export function ghAvailable(): boolean {
  try {
    execSync("gh --version", { encoding: "utf-8", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function ghPrComments(cwd: string, prUrl: string): string {
  return execSync(`gh pr view ${prUrl} --comments --json comments -q ".comments[].body"`, {
    cwd,
    encoding: "utf-8",
    timeout: 30000,
  }).trim();
}
