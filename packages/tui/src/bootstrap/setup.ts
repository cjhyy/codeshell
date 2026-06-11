/**
 * Session setup — initializes the working directory, validates the
 * environment, and kicks off background prefetch jobs.
 *
 * Adapted from restored-src/src/setup.ts, keeping only the pieces
 * relevant to Code Shell's current architecture.
 */

import chalk from "chalk";
import type { PermissionMode } from "@cjhyy/code-shell-core";
import { rotateLogs, logger } from "@cjhyy/code-shell-core";

export interface SetupOptions {
  cwd: string;
  permissionMode: PermissionMode;
  customSessionId?: string;
}

export async function setup(options: SetupOptions): Promise<void> {
  const { cwd, permissionMode } = options;

  // 0. Trim old log files (keep last 7 days), then mark startup.
  rotateLogs();
  logger.info("setup.start", { cwd, permissionMode, level: logger.getMinLevel() });

  // 1. Node.js version check. Must match package.json `engines` (>=20.10) and
  // scripts/check-node.cjs — some deps use ESM import attributes
  // (`with { type: "json" }`) that Node 16/18 don't support, so a too-lax gate
  // here let a 18/19 runtime boot and then fail with an obscure runtime error.
  // (§5.6 #10)
  const m = process.version.match(/^v(\d+)\.(\d+)\./);
  const major = m ? parseInt(m[1], 10) : 0;
  const minor = m ? parseInt(m[2], 10) : 0;
  if (!m || major < 20 || (major === 20 && minor < 10)) {
    console.error(
      chalk.bold.red("Error: Code Shell requires Node.js >= 20.10."),
    );
    console.error(chalk.red(`  current: ${process.version}`));
    process.exit(1);
  }

  // 2. Validate cwd exists
  try {
    const { statSync } = await import("fs");
    if (!statSync(cwd).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    console.error(chalk.red(`Error: Working directory does not exist: ${cwd}`));
    process.exit(1);
  }

  // 3. Permission bypass safety check
  if (permissionMode === "bypassPermissions") {
    if (
      process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      process.getuid() === 0 &&
      process.env.IS_SANDBOX !== "1"
    ) {
      console.error(
        chalk.red(
          "bypassPermissions cannot be used with root/sudo privileges for security reasons.",
        ),
      );
      process.exit(1);
    }
  }

  // 4. Set working directory. chdir can throw (missing dir, permissions) —
  // surface a clear error instead of an opaque stack from deep in bootstrap.
  if (process.cwd() !== cwd) {
    try {
      process.chdir(cwd);
    } catch (err) {
      throw new Error(
        `Cannot switch to working directory ${cwd}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  // 5. Check if inside a git repo (informational, non-blocking)
  try {
    const { execSync } = await import("child_process");
    execSync("git rev-parse --is-inside-work-tree", {
      cwd,
      stdio: "ignore",
    });
  } catch {
    // Not a git repo — that's fine, just skip git features
  }
}
