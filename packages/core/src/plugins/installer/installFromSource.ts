import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gitClone } from "../gitOps.js";
import { installPluginFromPath } from "./install.js";
import { pluginMetaPath } from "./paths.js";
import { PluginInstallError, type CSMeta } from "./types.js";
import type { ParsedSource } from "./parseSource.js";

/**
 * Remote install orchestrator: a thin bridge over the existing pieces. Clone
 * the git source to a private temp dir, hand the (sub)directory to the local
 * installer (which does CC/Codex detect + convert + register), then rewrite
 * the recorded `.cs-meta.json` source back to the original git string so
 * `plugin list`/`update` see the git source instead of the throwaway clone.
 *
 * Guarantees: on any failure nothing is left behind — the temp clone is always
 * removed, and `installPluginFromPath` itself leaves no half-built install dir.
 * See spec docs/superpowers/specs/2026-05-29-plugin-remote-install-design.md.
 */
export async function installPluginFromSource(
  parsed: ParsedSource,
  name: string,
  installedAt: string,
): Promise<string> {
  if (parsed.kind !== "remote") {
    throw new PluginInstallError("installPluginFromSource expects a remote source");
  }

  const tmp = mkdtempSync(join(tmpdir(), "cs-tmp-clone-"));
  try {
    const clone = await gitClone(parsed.url, tmp, { ref: parsed.ref });
    if (!clone.ok) {
      throw new PluginInstallError(`clone failed: ${clone.error}`);
    }

    const realSrc = parsed.subdir ? join(tmp, parsed.subdir) : tmp;
    if (!existsSync(realSrc) || !statSync(realSrc).isDirectory()) {
      throw new PluginInstallError(`subdir not found in repo: ${parsed.subdir}`);
    }

    const dir = await installPluginFromPath(realSrc, name, installedAt);

    // Rewrite source: realSrc is the throwaway clone path; record the git
    // string so list/update can re-clone later.
    const metaPath = pluginMetaPath(name);
    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as CSMeta;
    meta.source = parsed.raw;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    return dir;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
