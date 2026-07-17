import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { PluginInstallEntry, StoredPluginHookReview } from "./types.js";

const DIGEST_DOMAIN = "codeshell-plugin-hooks-v1";
const ABSENT_HOOKS = "<absent>";
const INVALID_HOOKS = "<invalid>";

/** Hard limits for one canonical plugin hook definition. */
export const MAX_PLUGIN_HOOK_FILE_BYTES = 1_048_576;
export const MAX_PLUGIN_HOOK_EVENTS = 32;
export const MAX_PLUGIN_HOOK_GROUPS = 128;
export const MAX_PLUGIN_HOOK_COMMANDS = 256;
export const MAX_PLUGIN_HOOK_EVENT_NAME_LENGTH = 128;
export const MAX_PLUGIN_HOOK_COMMAND_LENGTH = 32_768;
export const MAX_PLUGIN_HOOK_MATCHER_LENGTH = 4_096;
export const MAX_PLUGIN_HOOK_TIMEOUT_MS = 600_000;
export const MAX_PLUGIN_HOOK_REVIEW_COMMAND_LENGTH = 4_096;

export const SUPPORTED_PLUGIN_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "Notification",
  "Stop",
  "SubagentStop",
] as const;

export type SupportedPluginHookEvent = (typeof SUPPORTED_PLUGIN_HOOK_EVENTS)[number];

export interface ParsedPluginCommandHook {
  command: string;
  async?: boolean;
  timeoutMs?: number;
}

export interface ParsedPluginHookGroup {
  matcher?: string;
  hooks: ParsedPluginCommandHook[];
}

export interface ParsedPluginHooksDefinition {
  hooks: Partial<Record<SupportedPluginHookEvent, ParsedPluginHookGroup[]>>;
}

export interface PluginHooksSnapshot {
  state: "absent" | "valid" | "invalid";
  digest: string;
  definition: ParsedPluginHooksDefinition | null;
  hasExecutableHooks: boolean;
  error?: string;
}

export type PluginHookIntegrity = "verified" | "changed" | "legacy";
export type PluginHookApprovalState = "approved" | "pending" | "changed" | "legacy" | "none";

const SUPPORTED_EVENT_SET = new Set<string>(SUPPORTED_PLUGIN_HOOK_EVENTS);

function digestHooks(payload: Buffer | string): string {
  return createHash("sha256").update(DIGEST_DOMAIN).update("\0").update(payload).digest("hex");
}

function invalidSnapshot(error: string): PluginHooksSnapshot {
  return {
    state: "invalid",
    digest: digestHooks(INVALID_HOOKS),
    definition: null,
    hasExecutableHooks: false,
    error,
  };
}

function absentSnapshot(): PluginHooksSnapshot {
  return {
    state: "absent",
    digest: digestHooks(ABSENT_HOOKS),
    definition: null,
    hasExecutableHooks: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function pathIsWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function readBoundedRegularFile(installPath: string): Buffer | null | Error {
  const hooksDir = join(installPath, "hooks");
  const hooksPath = join(hooksDir, "hooks.json");

  let rootReal: string;
  try {
    const rootStat = lstatSync(installPath);
    if (!rootStat.isDirectory()) return new Error("plugin install path is not a directory");
    rootReal = realpathSync(installPath);
  } catch (error) {
    return isMissingFileError(error) ? null : (error as Error);
  }

  try {
    const hooksDirStat = lstatSync(hooksDir);
    if (hooksDirStat.isSymbolicLink() || !hooksDirStat.isDirectory()) {
      return new Error("canonical hooks directory must be a regular directory");
    }
  } catch (error) {
    return isMissingFileError(error) ? null : (error as Error);
  }

  let pathStat;
  try {
    pathStat = lstatSync(hooksPath);
  } catch (error) {
    return isMissingFileError(error) ? null : (error as Error);
  }
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    return new Error("canonical hooks file must be a regular file");
  }
  if (pathStat.size > MAX_PLUGIN_HOOK_FILE_BYTES) {
    return new Error(`canonical hooks file exceeds ${MAX_PLUGIN_HOOK_FILE_BYTES} bytes`);
  }

  let targetReal: string;
  try {
    targetReal = realpathSync(hooksPath);
  } catch (error) {
    return error as Error;
  }
  if (!pathIsWithin(rootReal, targetReal)) {
    return new Error("canonical hooks file escapes the plugin install path");
  }

  let fd: number | undefined;
  try {
    fd = openSync(hooksPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStat = fstatSync(fd);
    if (!openedStat.isFile()) return new Error("canonical hooks file must be a regular file");
    if (openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      return new Error("canonical hooks file changed while being opened");
    }
    if (openedStat.size > MAX_PLUGIN_HOOK_FILE_BYTES) {
      return new Error(`canonical hooks file exceeds ${MAX_PLUGIN_HOOK_FILE_BYTES} bytes`);
    }

    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const remaining = MAX_PLUGIN_HOOK_FILE_BYTES + 1 - total;
      if (remaining <= 0) {
        return new Error(`canonical hooks file exceeds ${MAX_PLUGIN_HOOK_FILE_BYTES} bytes`);
      }
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_PLUGIN_HOOK_FILE_BYTES) {
        return new Error(`canonical hooks file exceeds ${MAX_PLUGIN_HOOK_FILE_BYTES} bytes`);
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    return error as Error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseHooksDefinition(bytes: Buffer): ParsedPluginHooksDefinition {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `invalid hooks JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isRecord(value)) throw new Error("hooks document must be an object");

  const rawHooks = value.hooks;
  if (rawHooks === undefined) return { hooks: {} };
  if (!isRecord(rawHooks)) throw new Error("hooks must be an object");

  const events = Object.entries(rawHooks);
  if (events.length > MAX_PLUGIN_HOOK_EVENTS) {
    throw new Error(`hooks define more than ${MAX_PLUGIN_HOOK_EVENTS} events`);
  }

  const parsed: ParsedPluginHooksDefinition = { hooks: {} };
  let groupCount = 0;
  let commandCount = 0;

  for (const [eventName, rawGroups] of events) {
    if (eventName.length === 0 || eventName.length > MAX_PLUGIN_HOOK_EVENT_NAME_LENGTH) {
      throw new Error(
        `hook event names must contain 1-${MAX_PLUGIN_HOOK_EVENT_NAME_LENGTH} characters`,
      );
    }
    if (!Array.isArray(rawGroups)) {
      throw new Error(`hook event "${eventName}" must be an array`);
    }
    groupCount += rawGroups.length;
    if (groupCount > MAX_PLUGIN_HOOK_GROUPS) {
      throw new Error(`hooks define more than ${MAX_PLUGIN_HOOK_GROUPS} groups`);
    }

    const supported = SUPPORTED_EVENT_SET.has(eventName);
    const parsedGroups: ParsedPluginHookGroup[] = [];
    for (const rawGroup of rawGroups) {
      if (!isRecord(rawGroup)) throw new Error(`hook group for "${eventName}" must be an object`);

      const matcher = rawGroup.matcher;
      if (matcher !== undefined) {
        if (typeof matcher !== "string") {
          throw new Error(`hook matcher for "${eventName}" must be a string`);
        }
        if (matcher.length > MAX_PLUGIN_HOOK_MATCHER_LENGTH) {
          throw new Error(
            `hook matcher for "${eventName}" exceeds ${MAX_PLUGIN_HOOK_MATCHER_LENGTH} characters`,
          );
        }
        try {
          new RegExp(matcher);
        } catch {
          throw new Error(`hook matcher for "${eventName}" is not a valid regular expression`);
        }
      }

      const rawCommands = rawGroup.hooks;
      if (rawCommands !== undefined && !Array.isArray(rawCommands)) {
        throw new Error(`hook commands for "${eventName}" must be an array`);
      }
      const commands = rawCommands ?? [];
      commandCount += commands.length;
      if (commandCount > MAX_PLUGIN_HOOK_COMMANDS) {
        throw new Error(`hooks define more than ${MAX_PLUGIN_HOOK_COMMANDS} commands`);
      }

      const parsedCommands: ParsedPluginCommandHook[] = [];
      for (const rawCommand of commands) {
        if (!isRecord(rawCommand)) {
          throw new Error(`hook command for "${eventName}" must be an object`);
        }
        if (rawCommand.type !== "command") continue;

        const command = rawCommand.command;
        if (typeof command !== "string") {
          throw new Error(`command hook for "${eventName}" must include a string command`);
        }
        if (command.length > MAX_PLUGIN_HOOK_COMMAND_LENGTH) {
          throw new Error(
            `command hook for "${eventName}" exceeds ${MAX_PLUGIN_HOOK_COMMAND_LENGTH} characters`,
          );
        }
        if (rawCommand.async !== undefined && typeof rawCommand.async !== "boolean") {
          throw new Error(`command hook async flag for "${eventName}" must be boolean`);
        }
        const timeoutMs = rawCommand.timeout_ms;
        if (
          timeoutMs !== undefined &&
          (typeof timeoutMs !== "number" ||
            !Number.isSafeInteger(timeoutMs) ||
            timeoutMs < 1 ||
            timeoutMs > MAX_PLUGIN_HOOK_TIMEOUT_MS)
        ) {
          throw new Error(
            `command hook timeout for "${eventName}" must be an integer between 1 and ${MAX_PLUGIN_HOOK_TIMEOUT_MS}`,
          );
        }

        if (supported && command.trim().length > 0) {
          parsedCommands.push({
            command,
            ...(rawCommand.async === undefined ? {} : { async: rawCommand.async }),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          });
        }
      }

      if (supported) {
        parsedGroups.push({
          ...(matcher === undefined ? {} : { matcher: matcher as string }),
          hooks: parsedCommands,
        });
      }
    }

    if (supported) {
      parsed.hooks[eventName as SupportedPluginHookEvent] = parsedGroups;
    }
  }

  return parsed;
}

/**
 * Securely read and parse the one canonical hook file. All digest, approval,
 * listing, and runtime decisions consume this snapshot so malformed or
 * replaced files cannot be interpreted differently by separate code paths.
 */
export function inspectPluginHooks(installPath: string): PluginHooksSnapshot {
  const bytes = readBoundedRegularFile(installPath);
  if (bytes === null) return absentSnapshot();
  if (bytes instanceof Error) return invalidSnapshot(bytes.message);

  try {
    const definition = parseHooksDefinition(bytes);
    return {
      state: "valid",
      digest: digestHooks(bytes),
      definition,
      hasExecutableHooks: Object.values(definition.hooks).some((groups) =>
        groups?.some((group) => group.hooks.length > 0),
      ),
    };
  } catch (error) {
    return invalidSnapshot(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Digest the exact canonical hooks file after it passes the bounded parser.
 * Valid and absent definitions preserve the existing v1 digest contract;
 * every invalid definition shares a fail-closed sentinel digest.
 */
export function pluginHooksDigest(installPath: string): string {
  return inspectPluginHooks(installPath).digest;
}

/** Whether the bounded canonical definition currently contains an executable command hook. */
export function pluginHasExecutableHooks(installPath: string): boolean {
  return inspectPluginHooks(installPath).hasExecutableHooks;
}

function reviewCommand(
  command: string,
): Pick<StoredPluginHookReview, "command" | "commandDigest" | "commandTruncated"> {
  const truncated = command.length > MAX_PLUGIN_HOOK_REVIEW_COMMAND_LENGTH;
  return {
    command: truncated
      ? `${command.slice(0, MAX_PLUGIN_HOOK_REVIEW_COMMAND_LENGTH - 1)}…`
      : command,
    commandDigest: createHash("sha256").update(command).digest("hex"),
    ...(truncated ? { commandTruncated: true } : {}),
  };
}

/** Build bounded, non-executable review metadata from one validated snapshot. */
export function pluginHookReviewSnapshot(snapshot: PluginHooksSnapshot): StoredPluginHookReview[] {
  if (!snapshot.definition) return [];
  const out: StoredPluginHookReview[] = [];
  for (const rawEvent of Object.keys(snapshot.definition.hooks) as SupportedPluginHookEvent[]) {
    for (const group of snapshot.definition.hooks[rawEvent] ?? []) {
      for (const hook of group.hooks) {
        out.push({
          rawEvent,
          ...(group.matcher === undefined ? {} : { matcher: group.matcher }),
          ...reviewCommand(hook.command),
          ...(hook.async === undefined ? {} : { async: hook.async }),
          ...(hook.timeoutMs === undefined ? {} : { timeoutMs: hook.timeoutMs }),
        });
      }
    }
  }
  return out;
}

/**
 * Older installed_plugins.json entries predate hook digests and remain
 * compatible as `legacy`. New entries fail closed when their effective hook
 * file no longer matches the bytes approved by install/update.
 */
export function verifyPluginHookIntegrity(
  entry: PluginInstallEntry,
  snapshot: PluginHooksSnapshot = inspectPluginHooks(entry.installPath),
): PluginHookIntegrity {
  if (!entry.hookDigest) return "legacy";
  return snapshot.digest === entry.hookDigest ? "verified" : "changed";
}

/**
 * Runtime trust state for one installed plugin. Legacy entries stay compatible;
 * new entries with executable hooks remain pending until the approved digest
 * matches the install-time digest. Invalid definitions always fail closed as
 * hook-free regardless of legacy state.
 */
export function pluginHookApprovalState(
  entry: PluginInstallEntry,
  snapshot: PluginHooksSnapshot = inspectPluginHooks(entry.installPath),
): PluginHookApprovalState {
  if (!snapshot.hasExecutableHooks) return "none";
  const integrity = verifyPluginHookIntegrity(entry, snapshot);
  if (integrity === "legacy") return "legacy";
  if (integrity === "changed") return "changed";
  return entry.approvedHookDigest === entry.hookDigest ? "approved" : "pending";
}

/**
 * Integrity fields written at install/update. Hook-free packages approve the
 * absent-hooks digest automatically; executable hooks require explicit trust.
 * A previously approved identical digest remains approved across an update.
 */
export function pluginHookInstallRecord(
  installPath: string,
  previousEntries: PluginInstallEntry[] = [],
): Pick<PluginInstallEntry, "hookDigest" | "approvedHookDigest" | "approvedHookSnapshot"> {
  const snapshot = inspectPluginHooks(installPath);
  const previouslyApproved = previousEntries.find(
    (entry) =>
      entry.hookDigest === snapshot.digest && entry.approvedHookDigest === entry.hookDigest,
  );
  const previousReview = previousEntries.find(
    (entry) =>
      entry.approvedHookDigest === entry.hookDigest && entry.approvedHookSnapshot !== undefined,
  )?.approvedHookSnapshot;
  const approved =
    snapshot.state !== "invalid" && (!snapshot.hasExecutableHooks || previouslyApproved);
  return {
    hookDigest: snapshot.digest,
    ...(approved ? { approvedHookDigest: snapshot.digest } : {}),
    ...(approved
      ? { approvedHookSnapshot: pluginHookReviewSnapshot(snapshot) }
      : previousReview
        ? { approvedHookSnapshot: previousReview }
        : {}),
  };
}
