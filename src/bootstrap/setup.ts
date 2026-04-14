/**
 * Session setup — initializes the working directory, validates the
 * environment, and kicks off background prefetch jobs.
 *
 * Adapted from restored-src/src/setup.ts, keeping only the pieces
 * relevant to Code Shell's current architecture.
 */

import chalk from "chalk";
import type { PermissionMode } from "../types.js";

export interface SetupOptions {
  cwd: string;
  permissionMode: PermissionMode;
  customSessionId?: string;
}

export async function setup(options: SetupOptions): Promise<void> {
  const { cwd, permissionMode } = options;

  // 1. Node.js version check (require >= 18)
  const nodeVersion = process.version.match(/^v(\d+)\./)?.[1];
  if (!nodeVersion || parseInt(nodeVersion) < 18) {
    console.error(
      chalk.bold.red("Error: Code Shell requires Node.js version 18 or higher."),
    );
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

  // 4. Set working directory
  if (process.cwd() !== cwd) {
    process.chdir(cwd);
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
