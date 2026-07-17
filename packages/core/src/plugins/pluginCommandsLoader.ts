/**
 * Discover plugin-provided slash commands. For each installed plugin,
 * walks <installPath>/commands/*.md and returns one PluginCommand per
 * markdown file. Mirrors Claude Code's loadPluginCommands.ts at the
 * MVP subset (single-level commands directory, no nested subcommands,
 * no inline-via-plugin.json commands).
 */

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import { memoize } from "../utils/memoize.js";
import { parseFrontmatter, coerceDescription } from "../skills/frontmatter.js";
import { installedPluginsPath, readInstalledPlugins } from "./installedPlugins.js";

export interface PluginCommand {
  /** Namespaced name, e.g. "superpowers:brainstorming" */
  name: string;
  /** Plain command (without plugin prefix), e.g. "brainstorming" */
  commandName: string;
  /** Plugin id (without @marketplace), e.g. "superpowers" */
  pluginName: string;
  /** Frontmatter description, coerced. May be empty. */
  description: string;
  /** Frontmatter "argument-hint" if present. */
  argumentHint?: string;
  /** Body of the .md (frontmatter stripped). */
  body: string;
  /** Absolute path to the .md file. */
  filePath: string;
}

export interface PluginCommandDescriptor {
  name: string;
  pluginName: string;
  description: string;
  argumentHint?: string;
}

/** Bounded prompt contribution limits shared by Desktop, TUI, and protocol hosts. */
export const MAX_PLUGIN_COMMAND_FILE_BYTES = 256 * 1024;
export const MAX_PLUGIN_COMMAND_ARGUMENT_CHARS = 32 * 1024;
export const MAX_PLUGIN_COMMAND_EXPANDED_CHARS = 512 * 1024;

function isENOENT(e: unknown): boolean {
  return (
    typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === "ENOENT"
  );
}

function isInaccessible(e: unknown): boolean {
  if (typeof e !== "object" || e === null || !("code" in e)) return false;
  const code = (e as { code?: string }).code;
  return code === "EACCES" || code === "EPERM" || code === "EIO" || code === "ELOOP";
}

function userHome(): string {
  return process.env.HOME ?? homedir();
}

function readCommandFile(filePath: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_PLUGIN_COMMAND_FILE_BYTES) return null;

    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const remaining = MAX_PLUGIN_COMMAND_FILE_BYTES + 1 - total;
      if (remaining <= 0) return null;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_PLUGIN_COMMAND_FILE_BYTES) return null;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total).toString("utf-8");
  } catch (e) {
    if (isENOENT(e)) return null;
    if (isInaccessible(e)) {
      // eslint-disable-next-line no-console
      console.warn(`[plugin-commands] cannot read ${filePath}: ${(e as Error).message}`);
      return null;
    }
    throw e;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Resolve a plugin contribution through symlinks and require it to remain
 * inside its declared owner directory. Installed plugin trees are untrusted:
 * without this check `commands -> /some/private/dir` or `command.md` symlinks
 * could make the host read arbitrary local Markdown and expose it as a prompt.
 */
function resolveContainedPath(root: string, candidate: string): string | null {
  try {
    const realRoot = realpathSync(root);
    const realCandidate = realpathSync(candidate);
    const rel = relative(realRoot, realCandidate);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    return realCandidate;
  } catch {
    return null;
  }
}

function scanOnce(): PluginCommand[] {
  const data = readInstalledPlugins();
  const out: PluginCommand[] = [];
  const seen = new Set<string>();

  const keys = Object.keys(data.plugins).sort();
  for (const key of keys) {
    const entries = data.plugins[key] ?? [];
    const atIdx = key.lastIndexOf("@");
    const pluginName = atIdx > 0 ? key.slice(0, atIdx) : key;

    for (const entry of entries) {
      const commandsDir = join(entry.installPath, "commands");
      if (!existsSync(commandsDir)) continue;
      const resolvedCommandsDir = resolveContainedPath(entry.installPath, commandsDir);
      if (!resolvedCommandsDir) continue;

      let dirEntries;
      try {
        dirEntries = readdirSync(resolvedCommandsDir, { withFileTypes: true }).sort((a, b) =>
          a.name.localeCompare(b.name),
        );
      } catch (e) {
        if (isInaccessible(e)) {
          // eslint-disable-next-line no-console
          console.warn(
            `[plugin-commands] cannot read ${resolvedCommandsDir}: ${(e as Error).message}`,
          );
          continue;
        }
        throw e;
      }

      for (const dirent of dirEntries) {
        if (!dirent.isFile() && !dirent.isSymbolicLink()) continue;
        if (!dirent.name.endsWith(".md")) continue;
        const filePath = resolveContainedPath(
          resolvedCommandsDir,
          join(resolvedCommandsDir, dirent.name),
        );
        if (!filePath) continue;
        try {
          const fileStat = statSync(filePath);
          if (!fileStat.isFile() || fileStat.size > MAX_PLUGIN_COMMAND_FILE_BYTES) continue;
        } catch {
          continue;
        }
        const raw = readCommandFile(filePath);
        if (raw === null) continue;

        const baseName = dirent.name.slice(0, -3); // drop .md
        const namespaced = `${pluginName}:${baseName}`;
        if (seen.has(namespaced)) continue;

        const { frontmatter, body } = parseFrontmatter(raw);
        const description = coerceDescription(frontmatter.description);
        const argumentHint =
          typeof frontmatter["argument-hint"] === "string"
            ? frontmatter["argument-hint"]
            : undefined;

        out.push({
          name: namespaced,
          commandName: baseName,
          pluginName,
          description,
          argumentHint,
          body,
          filePath,
        });
        seen.add(namespaced);
      }
    }
  }
  return out;
}

function installedPluginsMtime(): string {
  const p = installedPluginsPath();
  try {
    return statSync(p).mtimeMs.toString();
  } catch {
    return "0";
  }
}

const memoized = memoize(scanOnce, () => `${userHome()}\0${installedPluginsMtime()}`);

export function scanPluginCommands(): PluginCommand[] {
  return memoized();
}

export function invalidatePluginCommandsCache(): void {
  memoized.cache.clear?.();
}

interface ParsedPluginCommandArguments {
  positional: string[];
  named: Map<string, string>;
}

function parsePluginCommandArguments(input: string): ParsedPluginCommandArguments {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  const push = () => {
    if (current.length === 0) return;
    tokens.push(current);
    current = "";
  };

  for (const character of input.trim()) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      push();
      continue;
    }
    current += character;
  }
  if (escaping) current += "\\";
  push();

  const positional: string[] = [];
  const named = new Map<string, string>();
  for (const token of tokens) {
    const assignment = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(token);
    if (assignment) named.set(assignment[1], assignment[2]);
    else positional.push(token);
  }
  return { positional, named };
}

export function describePluginCommands(
  commands: readonly Pick<PluginCommand, "name" | "pluginName" | "description" | "argumentHint">[],
  disabledPluginNames: ReadonlySet<string> = new Set(),
): PluginCommandDescriptor[] {
  return commands
    .filter((command) => !disabledPluginNames.has(command.pluginName))
    .map((command) => ({
      name: command.name,
      pluginName: command.pluginName,
      description: command.description,
      ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

const PLUGIN_COMMAND_PLACEHOLDER =
  /\$\$|\$ARGUMENTS|\{args\}|\$([1-9])|\$([A-Z][A-Z0-9_]*)(?![A-Z0-9_])/gu;

function pluginCommandReplacement(
  token: string,
  positionalIndex: string | undefined,
  namedPlaceholder: string | undefined,
  rawArguments: string,
  parsed: ParsedPluginCommandArguments,
): string {
  if (token === "$$") return "$";
  if (token === "$ARGUMENTS" || token === "{args}") return rawArguments;
  if (positionalIndex) return parsed.positional[Number(positionalIndex) - 1] ?? "";
  if (namedPlaceholder && parsed.named.has(namedPlaceholder)) {
    return parsed.named.get(namedPlaceholder)!;
  }
  return token;
}

function assertExpansionBudget(
  body: string,
  rawArguments: string,
  parsed: ParsedPluginCommandArguments,
): void {
  if (Buffer.byteLength(body, "utf-8") > MAX_PLUGIN_COMMAND_FILE_BYTES) {
    throw new Error(`plugin command body exceeds ${MAX_PLUGIN_COMMAND_FILE_BYTES} bytes`);
  }
  if (rawArguments.length > MAX_PLUGIN_COMMAND_ARGUMENT_CHARS) {
    throw new Error(
      `plugin command arguments exceed ${MAX_PLUGIN_COMMAND_ARGUMENT_CHARS} characters`,
    );
  }

  let projected = body.length;
  for (const match of body.matchAll(PLUGIN_COMMAND_PLACEHOLDER)) {
    projected +=
      pluginCommandReplacement(match[0], match[1], match[2], rawArguments, parsed).length -
      match[0].length;
    if (projected > MAX_PLUGIN_COMMAND_EXPANDED_CHARS) break;
  }
  if (projected > MAX_PLUGIN_COMMAND_EXPANDED_CHARS) {
    throw new Error(
      `expanded plugin command exceeds ${MAX_PLUGIN_COMMAND_EXPANDED_CHARS} characters`,
    );
  }
}

/**
 * Expand CC/CodeShell and deprecated Codex custom-prompt placeholders.
 *
 * Codex plugins in the wild still ship `prompts/*.md`, so compatibility needs
 * `$1`…`$9`, named `KEY=value` placeholders, `$ARGUMENTS`, and `$$` literals
 * even though new upstream workflows are expected to use skills.
 */
export function expandPluginCommandBody(body: string, rawArguments = ""): string {
  if (rawArguments.length > MAX_PLUGIN_COMMAND_ARGUMENT_CHARS) {
    throw new Error(
      `plugin command arguments exceed ${MAX_PLUGIN_COMMAND_ARGUMENT_CHARS} characters`,
    );
  }
  const parsed = parsePluginCommandArguments(rawArguments);
  assertExpansionBudget(body, rawArguments, parsed);
  const expanded = body.replace(
    PLUGIN_COMMAND_PLACEHOLDER,
    (token, positionalIndex: string | undefined, namedPlaceholder: string | undefined) =>
      pluginCommandReplacement(token, positionalIndex, namedPlaceholder, rawArguments, parsed),
  );
  if (expanded.length > MAX_PLUGIN_COMMAND_EXPANDED_CHARS) {
    throw new Error(
      `expanded plugin command exceeds ${MAX_PLUGIN_COMMAND_EXPANDED_CHARS} characters`,
    );
  }
  return expanded;
}
