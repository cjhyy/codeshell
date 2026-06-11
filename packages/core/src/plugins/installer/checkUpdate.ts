import { existsSync, readFileSync } from "node:fs";
import { gitLsRemote } from "../gitOps.js";
import { pluginMetaPath } from "./paths.js";
import { parseSource } from "./parseSource.js";
import { CSMeta, PluginInstallError } from "./types.js";

export interface UpdateCheck {
  name: string;
  updateAvailable: boolean;
  currentCommit?: string; // from meta.commit
  latestCommit?: string; // from ls-remote
  reason?: string; // why we couldn't determine (not-remote / no-base-commit / ls-remote failed)
}

/**
 * Check whether a remote (git-sourced) plugin has a newer commit upstream,
 * WITHOUT cloning. Compares the recorded install commit (meta.commit) against
 * `git ls-remote`. Local-source plugins, older installs without a recorded
 * commit, and ls-remote failures all resolve to `updateAvailable: false` with
 * an explanatory `reason` rather than throwing — the only hard error is an
 * unknown plugin name.
 */
export async function checkPluginUpdate(name: string): Promise<UpdateCheck> {
  const metaPath = pluginMetaPath(name);
  if (!existsSync(metaPath)) throw new PluginInstallError(`no plugin named '${name}'`);
  const meta = CSMeta.parse(JSON.parse(readFileSync(metaPath, "utf-8")));

  const parsed = parseSource(meta.source);
  if (parsed.kind !== "remote") {
    return { name, updateAvailable: false, reason: "not a remote source" };
  }
  if (!meta.commit) {
    return { name, updateAvailable: false, reason: "no recorded commit to compare" };
  }

  const latest = await gitLsRemote(parsed.url, parsed.ref);
  if (!latest.ok) {
    return { name, updateAvailable: false, currentCommit: meta.commit, reason: latest.error };
  }

  const updateAvailable = latest.stdout.toLowerCase() !== meta.commit.toLowerCase();
  return { name, updateAvailable, currentCommit: meta.commit, latestCommit: latest.stdout };
}
