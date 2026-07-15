import { execFile, execFileSync } from "node:child_process";
import { killChildTree, resolveExecutable } from "@cjhyy/code-shell-core/extension";

// git resolved via PATH×PATHEXT on Windows (.cmd/.exe shim); no-op on POSIX.
export const GIT_BIN = resolveExecutable("git");

export async function execGit(
  cwd: string,
  args: string[],
  timeout = 10000,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    let settled = false;
    const child = execFile(GIT_BIN, args, { cwd, encoding: "utf-8" }, (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        Object.assign(error, { stdout, stderr });
        reject(error);
      } else {
        resolve(stdout);
      }
    });
    const terminate = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      killChildTree(child, 1000);
      reject(error);
    };
    const onAbort = () =>
      terminate(
        signal?.reason ?? Object.assign(new Error("Git command aborted"), { name: "AbortError" }),
      );
    const timer = setTimeout(() => {
      terminate(
        Object.assign(new Error(`Git command timed out after ${timeout}ms`), {
          code: "ETIMEDOUT",
        }),
      );
    }, timeout);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
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
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    return await execGit(cwd, args, timeout, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
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
