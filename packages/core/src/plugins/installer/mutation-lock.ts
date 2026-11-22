import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { lock } from "../../utils/lockfile.js";
import { pluginInstallDir } from "./paths.js";

/** An overwrite temporarily vacates the installed name. Serialize competing
 * publications and detachments while retaining per-plugin concurrency. */
export async function withLocalPluginMutation<T>(name: string, run: () => Promise<T>) {
  const root = dirname(pluginInstallDir(name));
  const locks = join(dirname(root), ".plugin-publication-locks");
  await mkdir(locks, { recursive: true, mode: 0o700 });
  const key = createHash("sha256").update(name.normalize("NFC").toLowerCase()).digest("hex");
  const release = await lock(join(locks, key), {
    realpath: false,
    stale: 30000,
    retries: { retries: 150, minTimeout: 20, maxTimeout: 200 },
  });
  try {
    return await run();
  } finally {
    await release();
  }
}
