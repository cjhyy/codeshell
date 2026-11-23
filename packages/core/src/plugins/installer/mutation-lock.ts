import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { lock, lockSync } from "../../utils/lockfile.js";
import { pluginInstallDir } from "./paths.js";

/** An overwrite temporarily vacates the installed name. Serialize competing
 * publications and detachments while retaining per-plugin concurrency. */
export async function withLocalPluginMutation<T>(name: string, run: () => Promise<T>) {
  const root = dirname(pluginInstallDir(name));
  const locks = join(dirname(root), ".plugin-publication-locks");
  mkdirSync(locks, { recursive: true, mode: 0o700 });
  const key = createHash("sha256").update(name.normalize("NFC").toLowerCase()).digest("hex");
  const target = join(locks, key);
  // A stalled event loop (system sleep during a clone) can let another process
  // take the lease. The default handler throws from a timer and kills the Host.
  let compromised = false;
  const options = {
    realpath: false,
    stale: 30_000,
    onCompromised: () => {
      compromised = true;
    },
  };
  let release: () => void | Promise<void>;
  try {
    // In the uncontended case an uninstall must detach before the caller can reuse the name.
    release = lockSync(target, options);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ELOCKED" && code !== "EEXIST") throw error;
    release = await lock(target, {
      ...options,
      retries: { retries: 150, minTimeout: 20, maxTimeout: 200 },
    });
  }
  // The lease of a compromised lock belongs to its new holder; there is nothing left to release.
  const unlock = async () => {
    try {
      await release();
    } catch (error) {
      if (!compromised) throw error;
    }
  };
  try {
    return await run();
  } finally {
    await unlock();
  }
}
