/**
 * Which external Agent Runtimes this machine can actually run.
 *
 * The picker must not advertise a runtime whose binary is missing: the user
 * would select it, send a message, and get a spawn failure — a failure that
 * looks like the feature is broken rather than absent. So the model list is
 * gated on this probe.
 *
 * PATH resolution deliberately uses the same merged login-shell PATH the
 * runtimes will be spawned with. A GUI app on macOS inherits a minimal PATH
 * that usually lacks `~/.local/bin`, `/opt/homebrew/bin` and every version
 * manager's shim directory — probing `process.env.PATH` would report "not
 * installed" for a `codex` the user can run in their terminal, which is the
 * confusing direction.
 */
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { ExternalRuntimeModelKind } from "../shared/external-runtime-models.js";
import { dlog } from "./desktop-logger.js";

/** The binary each runtime is driven through. */
const RUNTIME_BINARIES: Readonly<Record<ExternalRuntimeModelKind, string>> = Object.freeze({
  codex: "codex",
  "claude-code": "claude",
});

/** Windows resolves a bare name against these extensions. */
function windowsCandidates(name: string): string[] {
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [name, ...exts.map((ext) => `${name}${ext.toLowerCase()}`)];
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
  } catch {
    return false;
  }
  if (process.platform === "win32") return true;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a bare command name against a PATH string.
 *
 * Exported for tests: the interesting cases (missing binary, present but not
 * executable, Windows extensions) are awkward to arrange against the real PATH.
 */
export function findOnPath(command: string, pathValue: string | undefined): string | null {
  if (!command) return null;
  // An absolute path in the setting bypasses PATH entirely.
  if (isAbsolute(command)) return isExecutableFile(command) ? command : null;
  const names = process.platform === "win32" ? windowsCandidates(command) : [command];
  for (const dir of (pathValue ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

export interface RuntimeAvailability {
  kind: ExternalRuntimeModelKind;
  binary: string;
  path: string | null;
}

/**
 * Probe every runtime. Synchronous on purpose — it is a handful of `stat`
 * calls against directories the OS has cached, and making it async would add a
 * loading state to the picker for no measurable gain.
 */
export function probeExternalRuntimes(
  pathValue: string | undefined = process.env.PATH,
): RuntimeAvailability[] {
  return (Object.keys(RUNTIME_BINARIES) as ExternalRuntimeModelKind[]).map((kind) => {
    const binary = RUNTIME_BINARIES[kind];
    return { kind, binary, path: findOnPath(binary, pathValue) };
  });
}

/** Just the kinds that are runnable, in the shape the renderer wants. */
export function availableExternalRuntimes(
  pathValue: string | undefined = process.env.PATH,
): ExternalRuntimeModelKind[] {
  const probed = probeExternalRuntimes(pathValue);
  const available = probed.filter((entry) => entry.path !== null).map((entry) => entry.kind);
  dlog("external-runtime", "availability.probed", {
    available,
    missing: probed.filter((entry) => entry.path === null).map((entry) => entry.binary),
  });
  return available;
}
