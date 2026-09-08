import { unwatchFile, watchFile } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Watch the files, including atomic replacements and initially absent stores.
 * Only active credential consumers subscribe, so idle workers have no watcher.
 * File polling also works when the host and worker are separate processes.
 */
export function subscribeToLocalCredentialChanges(
  listener: () => void,
  options: { cwd?: string; scope?: "full" | "project"; userDir?: string } = {},
): () => void {
  const paths = new Set<string>();
  if (options.scope !== "project") {
    paths.add(
      join(
        options.userDir ?? join(process.env.HOME ?? homedir(), ".code-shell"),
        "credentials.json",
      ),
    );
  }
  if (options.cwd) paths.add(join(options.cwd, ".code-shell", "credentials.json"));
  let active = true;
  const changed = () => {
    if (!active) return;
    try {
      listener();
    } catch {
      // A consumer cannot crash the shared filesystem watcher.
    }
  };
  for (const path of paths) {
    watchFile(path, { interval: 250, persistent: false }, changed);
  }
  return () => {
    if (!active) return;
    active = false;
    for (const path of paths) unwatchFile(path, changed);
  };
}
