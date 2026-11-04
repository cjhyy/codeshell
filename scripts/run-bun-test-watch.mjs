import { spawn } from "node:child_process";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment, explicitBunTestPaths } from "./bun-test-completion.mjs";

export function watchFiles(args, cwd = process.cwd()) {
  if (!args.length || args.length > 8)
    throw new Error(
      "watch requires 1–8 explicit test files (no directories); use bun run test for CI shards",
    );
  for (const arg of args) {
    if (
      arg.startsWith("-") ||
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(arg) ||
      !lstatSync(resolve(cwd, arg)).isFile()
    )
      throw new Error("watch requires explicit test files, not flags, patterns or directories");
  }
  return explicitBunTestPaths(args, cwd);
}

export async function runBunTestWatch(args, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const files = watchFiles(args, cwd);
  const directory = mkdtempSync(join(tmpdir(), "codeshell-bun-watch-"));
  let child;
  let killTimer;
  const stop = () => {
    child?.kill("SIGTERM");
    killTimer ??= setTimeout(() => child?.kill("SIGKILL"), 2_000);
    killTimer.unref();
  };
  try {
    child = (options.spawn ?? spawn)(
      options.bun ?? "bun",
      ["test", "--timeout", "30000", "--watch", ...files],
      {
        cwd,
        env: createBunTestEnvironment(options.env ?? process.env, directory),
        stdio: "inherit",
      },
    );
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    console.log(
      "Isolated interactive watch. Use bun run test (or the guarded shard runner) for a completed acceptance result.",
    );
    const result = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => done({ code, signal }));
    });
    if (result.code && !result.signal) throw new Error(`Bun watch failed (${result.code})`);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    clearTimeout(killTimer);
    rmSync(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runBunTestWatch(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
