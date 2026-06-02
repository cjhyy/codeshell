/**
 * Bun test preload (see bunfig.toml). Redirects the `.code-shell` home to a
 * throwaway temp dir for the whole test run, so any test that constructs an
 * Engine / SessionManager / RunManager WITHOUT an explicit storageDir writes
 * its sessions/memory under the temp dir instead of polluting the developer's
 * real ~/.code-shell/sessions (the rm-usage / test-model sidebar junk).
 *
 * Mirrors Codex's CODEX_HOME test isolation. A test that needs its own dir can
 * still pass an explicit path or override process.env.CODE_SHELL_HOME locally.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Only set it if a test hasn't pinned one already (lets per-test overrides win).
if (!process.env.CODE_SHELL_HOME) {
  process.env.CODE_SHELL_HOME = mkdtempSync(join(tmpdir(), "codeshell-test-home-"));
}
