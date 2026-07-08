import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { resolveExecutable } from "../../utils/exec.js";

// git resolved via PATH×PATHEXT on Windows (.cmd/.exe shim); no-op on POSIX.
export const GIT_BIN = resolveExecutable("git");

const execFileAsync = promisify(execFile);

export async function execGit(cwd: string, args: string[], timeout = 10000): Promise<string> {
  const { stdout } = await execFileAsync(GIT_BIN, args, {
    cwd,
    encoding: "utf-8",
    timeout,
  });
  return stdout;
}

export function execGitSync(cwd: string, args: string[], timeout = 10000): string {
  return execFileSync(GIT_BIN, args, {
    cwd,
    encoding: "utf-8",
    timeout,
  });
}

export async function gitOutput(
  cwd: string,
  args: string[],
  timeout = 10000,
): Promise<string | undefined> {
  try {
    return await execGit(cwd, args, timeout);
  } catch {
    return undefined;
  }
}

export function gitOutputSync(cwd: string, args: string[], timeout = 10000): string | undefined {
  try {
    return execGitSync(cwd, args, timeout);
  } catch {
    return undefined;
  }
}

export function gitErrorMessage(err: unknown): string {
  const stderr = (err as { stderr?: Buffer | string }).stderr;
  if (Buffer.isBuffer(stderr)) {
    const msg = stderr.toString("utf-8").trim();
    if (msg) return msg;
  }
  if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
  return err instanceof Error ? err.message : String(err);
}

export function normalizeBranchName(branch: string): string {
  return branch.replace(/^refs\/heads\//, "");
}
