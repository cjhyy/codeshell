import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the user's home directory. Prefers `process.env.HOME` so that
 * runtime env overrides (set after process start, e.g. in tests) actually
 * take effect — on some runtimes (e.g. Bun on macOS) `os.homedir()` is
 * cached from the user database at process startup and ignores later
 * `process.env.HOME` mutations.
 */
export function userHome(): string {
  return process.env.HOME ?? homedir();
}

/**
 * Resolve the `.code-shell` home dir. `CODE_SHELL_HOME` overrides the default
 * `~/.code-shell` — mirrors Codex's `CODEX_HOME`. Tests set it to a temp dir
 * (see bunfig.toml preload) so a `new Engine()` / `new SessionManager()` with
 * no explicit storageDir doesn't pollute the user's real ~/.code-shell/sessions
 * with throwaway test sessions (the rm-usage/test-model sidebar junk).
 */
export function codeShellHome(): string {
  return process.env.CODE_SHELL_HOME || join(homedir(), ".code-shell");
}
