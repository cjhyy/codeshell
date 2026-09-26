import { realpathSync } from "node:fs";
import { join } from "node:path";
import { codeShellHome } from "@cjhyy/code-shell-core/extension";
import { sha256Hex } from "./contracts/canonical-json.js";

/** Stable per-project key; symlinked paths to one project share it. */
export function projectKey(cwd: string): string {
  return sha256Hex(realpathSync(cwd)).slice(0, 16);
}

/** Long-lived lab directory for a project. Never a temp or task directory. */
export function labRoot(cwd: string): string {
  return join(codeShellHome(), "optimization-lab", projectKey(cwd));
}
