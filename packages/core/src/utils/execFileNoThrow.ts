/**
 * Execute a child process without throwing on non-zero exit.
 *
 * Distinguishes between:
 * - Spawn failure (file not found, permission denied) → code = null
 * - Non-zero exit (process ran but returned error) → code = exit code
 * - Success → code = 0
 */

import { execFile, type ExecFileOptions } from "node:child_process";

export interface ExecFileNoThrowResult {
  /** Process exit code (0 = success, null = spawn failed). */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ExecFileNoThrowOptions {
  /** stdin input to pipe to the process. */
  input?: string;
  /** Working directory. */
  cwd?: string;
  /** Timeout in ms (default 10_000). */
  timeout?: number;
  /** Environment variables to merge. */
  env?: Record<string, string | undefined>;
  /** Shell to run in (if true, uses platform default). */
  shell?: boolean | string;
}

/**
 * Run a command and return exit code + stdout/stderr.
 * Never throws — spawn failures return code=null.
 */
export function execFileNoThrow(
  file: string,
  args: string[],
  options?: ExecFileNoThrowOptions,
): Promise<ExecFileNoThrowResult> {
  return new Promise((resolve) => {
    const execOpts: ExecFileOptions = {
      timeout: options?.timeout ?? 10_000,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      encoding: "utf-8",
    };

    if (options?.cwd) execOpts.cwd = options.cwd;
    if (options?.env) execOpts.env = { ...process.env, ...options.env };
    if (options?.shell) execOpts.shell = options.shell === true ? undefined : options.shell;

    const child = execFile(file, args, execOpts, (error, stdout, stderr) => {
      if (error) {
        // Distinguish spawn failure vs non-zero exit
        const errno = error as NodeJS.ErrnoException;
        if (errno.code === "ENOENT" || errno.code === "EACCES" || errno.code === "EPERM") {
          // Spawn failure — file not found or permission denied
          resolve({
            code: null,
            stdout: String(stdout ?? ""),
            stderr: errno.message,
          });
        } else {
          // Non-zero exit or killed by signal
          resolve({
            code: error.code != null ? (typeof error.code === "number" ? error.code : 1) : 1,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
          });
        }
      } else {
        resolve({
          code: 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      }
    });

    // Pipe stdin if provided
    if (options?.input && child.stdin) {
      child.stdin.write(options.input);
      child.stdin.end();
    }
  });
}

/**
 * execFileNoThrow with explicit cwd (convenience wrapper).
 */
export function execFileNoThrowWithCwd(
  cwd: string,
  file: string,
  args: string[],
  options?: Omit<ExecFileNoThrowOptions, "cwd">,
): Promise<ExecFileNoThrowResult> {
  return execFileNoThrow(file, args, { ...options, cwd });
}

/**
 * @deprecated Use execFileNoThrow directly.
 */
export function execSyncWithDefaults_DEPRECATED(..._args: any[]): any {
  return undefined as any;
}
