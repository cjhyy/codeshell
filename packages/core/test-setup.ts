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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";

// Only set it if a test hasn't pinned one already (lets per-test overrides win).
if (!process.env.CODE_SHELL_HOME) {
  const sandbox = mkdtempSync(join(tmpdir(), "codeshell-test-home-"));
  process.env.CODE_SHELL_HOME = sandbox;
  // Remove the sandbox when the run ends. Without this every `bun test`
  // invocation leaked one directory per preloaded package forever, and
  // thousands accumulated in $TMPDIR on developer machines. Registered only
  // for the sandbox this preload created, so a run that pinned its own
  // CODE_SHELL_HOME still owns that directory's lifetime.
  //
  // This must be bun:test's afterAll, NOT process.on("exit"): the test runner
  // does not run exit listeners registered from a preload, so an exit handler
  // here never fires and the directory survives the run.
  afterAll(() => {
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      // Never let cleanup failure change a test run's exit status.
    }
  });
}

// 49 test files `delete process.env.CODE_SHELL_HOME` in their cleanup. Bun runs
// every test file in ONE process, so the first such cleanup strips this
// isolation for every suite that runs afterwards — which is how fixture
// sessions reached the real ~/.code-shell/sessions even with the preload
// active. Publish the sandbox separately under a name no test manages, so
// sessionsRoot() can fall back to it instead of the developer's real store.
process.env.CODE_SHELL_TEST_HOME = process.env.CODE_SHELL_HOME;
