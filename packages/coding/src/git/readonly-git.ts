import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { devNull } from "node:os";

export interface ReadOnlyGitCommandOptions {
  timeout: number;
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}
export type ReadOnlyGitExecutor = (
  cwd: string,
  args: string[],
  options: ReadOnlyGitCommandOptions,
) => Promise<Buffer | string>;

/** No caller-supplied Git location, config injection, tracing or credential environment. */
export function readOnlyGitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)),
  );
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
}
const execute: ReadOnlyGitExecutor = (cwd, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { ...options, cwd, encoding: "buffer", killSignal: "SIGKILL", windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
export function createReadOnlyGitRunner(options: {
  deadline: number;
  signal?: AbortSignal;
  execute?: ReadOnlyGitExecutor;
  commandTimeoutMs?: number;
}) {
  const env = readOnlyGitEnvironment();
  return async (cwd: string, args: string[], maxBuffer = 1024 * 1024): Promise<Buffer> => {
    const remaining = options.deadline - performance.now();
    if (remaining <= 0 || options.signal?.aborted) throw new Error("Git read deadline exceeded");
    const result = await (options.execute ?? execute)(
      cwd,
      [
        "--no-optional-locks",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        `core.attributesFile=${devNull}`,
        "-c",
        "core.hooksPath=" + devNull,
        "-c",
        "core.pager=cat",
        "-c",
        "diff.external=",
        "-c",
        "protocol.allow=never",
        ...args,
      ],
      {
        env,
        timeout: Math.max(
          1,
          Math.floor(Math.min(2000, options.commandTimeoutMs ?? 2000, remaining)),
        ),
        maxBuffer,
        signal: options.signal,
      },
    );
    if (options.signal?.aborted || performance.now() > options.deadline)
      throw new Error("Git read deadline exceeded");
    return Buffer.isBuffer(result) ? result : Buffer.from(result);
  };
}
export type ReadOnlyGitRunner = ReturnType<typeof createReadOnlyGitRunner>;

/** Binds to this repository instance, including replacement at the same path. */
export async function gitRepositoryId(canonicalCommonDir: string): Promise<string> {
  const info = await lstat(canonicalCommonDir);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Git common directory is not a regular directory");
  return createHash("sha256")
    .update(JSON.stringify([canonicalCommonDir, info.dev, info.ino, info.birthtimeMs]))
    .digest("hex");
}
