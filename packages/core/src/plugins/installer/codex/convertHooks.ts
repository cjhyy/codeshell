import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { PluginInstallError } from "../types.js";

type HookDeclaration = string | Record<string, unknown>;
type HooksMap = Record<string, unknown[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeHookDocument(value: unknown, label: string): HooksMap {
  if (!isRecord(value)) {
    throw new PluginInstallError(`${label}: hooks declaration must be an object`);
  }
  const candidate = isRecord(value.hooks) ? value.hooks : value;
  const hooks: HooksMap = {};
  for (const [event, groups] of Object.entries(candidate)) {
    if (!Array.isArray(groups)) {
      throw new PluginInstallError(`${label}: hook event '${event}' must be an array`);
    }
    hooks[event] = groups;
  }
  return hooks;
}

async function readHookDocument(sourceDir: string, declaration: string): Promise<HooksMap> {
  const base = await realpath(sourceDir);
  const candidate = resolve(base, declaration);
  const rel = relative(base, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PluginInstallError(`hooks ref escapes plugin dir: ${declaration}`);
  }
  if (!existsSync(candidate)) {
    throw new PluginInstallError(`hooks ref not found: ${declaration}`);
  }

  let target: string;
  try {
    target = await realpath(candidate);
  } catch {
    throw new PluginInstallError(`hooks ref not found: ${declaration}`);
  }
  const targetRel = relative(base, target);
  if (targetRel === ".." || targetRel.startsWith(`..${sep}`) || isAbsolute(targetRel)) {
    throw new PluginInstallError(`hooks ref escapes plugin dir: ${declaration}`);
  }

  try {
    return normalizeHookDocument(
      JSON.parse(await readFile(target, "utf-8")),
      `hooks ref ${declaration}`,
    );
  } catch (error) {
    if (error instanceof PluginInstallError) throw error;
    throw new PluginInstallError(
      `invalid hooks json ${declaration}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function mergeHooks(target: HooksMap, source: HooksMap): void {
  for (const [event, groups] of Object.entries(source)) {
    target[event] = [...(target[event] ?? []), ...groups];
  }
}

/**
 * Convert Codex plugin hook declarations into CodeShell's canonical
 * `hooks/hooks.json` location.
 *
 * Codex accepts a path, an inline object, or an array mixing both. CodeShell's
 * runtime intentionally has one loader path, so installation resolves and
 * merges those declarations once. When the manifest omits `hooks`, the normal
 * `hooks/hooks.json` copied from the source tree is already canonical.
 */
export async function copyCodexHooks(
  sourceDir: string,
  destDir: string,
  declaration:
    | string
    | Record<string, unknown>
    | Array<string | Record<string, unknown>>
    | undefined,
): Promise<void> {
  if (declaration === undefined) return;

  const declarations: HookDeclaration[] = Array.isArray(declaration) ? declaration : [declaration];
  const merged: HooksMap = {};
  for (const item of declarations) {
    if (typeof item === "string") {
      mergeHooks(merged, await readHookDocument(sourceDir, item));
    } else {
      mergeHooks(merged, normalizeHookDocument(item, "inline hooks"));
    }
  }

  const hooksDir = join(destDir, "hooks");
  await mkdir(hooksDir, { recursive: true });
  await writeFile(
    join(hooksDir, "hooks.json"),
    `${JSON.stringify({ hooks: merged }, null, 2)}\n`,
    "utf-8",
  );
}
