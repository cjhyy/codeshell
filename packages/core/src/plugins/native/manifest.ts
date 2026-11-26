/**
 * Native plugin manifest (`.codeshell-plugin/plugin.json`, schemaVersion 2).
 *
 * A plugin is "native" when its CodeShell manifest names a `main` entry: code
 * that the plugin runtime loads in the plugin's own child process and hands a
 * `ctx` to. Everything the entry may register is declared here first, so the
 * user can review it before any of the code runs and the runtime can refuse a
 * registration the manifest did not announce.
 *
 * schemaVersion 1 of the same file is the declarative overlay (automation
 * templates only) and is not a native plugin.
 */

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CONTRACTS } from "../../contracts.js";
import type { HookEventName } from "../../hooks/events.js";
import type { PLUGIN_API_VERSION, PluginHookEventName } from "../../plugin-sdk.js";
import { PluginAutomationsManifest } from "../installer/types.js";

export const NATIVE_PLUGIN_MANIFEST_FILE = ".codeshell-plugin/plugin.json";
/** The newest `ctx` contract this host implements. */
export const NATIVE_PLUGIN_API_VERSION = CONTRACTS.pluginApi;
const MAX_MANIFEST_BYTES = 1024 * 1024;

export const NATIVE_HOOK_EVENTS = [
  "on_agent_start",
  "on_agent_end",
  "on_turn_start",
  "on_turn_end",
  "on_stop",
  "on_tool_start",
  "on_tool_end",
  "on_permission_check",
  "on_session_start",
  "on_session_end",
  "pre_tool_use",
  "post_tool_use",
  "user_prompt_submit",
  "agent_direction_submit",
  "pre_compact",
  "post_compact",
  "file_changed",
  "notification",
] as const;

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** Compile-time only: a hook event added to the engine must be added here too. */
export type _NativeHookEventsCoverEveryEvent =
  Equal<(typeof NATIVE_HOOK_EVENTS)[number], HookEventName> extends true
    ? Equal<PluginHookEventName, HookEventName> extends true
      ? true
      : never
    : never;
const _eventsInSync: _NativeHookEventsCoverEveryEvent = true;
void _eventsInSync;
/** Compile-time only: the SDK a plugin builds against names this host's API version. */
const _apiInSync: Equal<typeof PLUGIN_API_VERSION, typeof CONTRACTS.pluginApi> = true;
void _apiInSync;

/**
 * One rule for the plugin's own name because it is embedded in every public
 * name: tool names (letters, digits, `_`, `-`), module ids and context ledger
 * keys (lower-case letters, digits, `-`). The strictest of them wins.
 */
const PLUGIN_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const CONTRIBUTION_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** `__` separates the parts of a public tool name, so a short name cannot contain it. */
const TOOL_NAME = /^[a-z](?:_?[a-z0-9])*$/;
const CAPABILITY_NAME = /^[a-z][A-Za-z0-9.:-]{0,63}$/;
const MAIN_ENTRY = /^(?:\.\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.m?js$/;
/** Model providers cap tool names at 64 characters. */
const MAX_PUBLIC_TOOL_NAME = 64;

function uniqueList<T extends z.ZodTypeAny>(item: T, max: number) {
  return z
    .array(item)
    .max(max)
    .superRefine((values, ctx) => {
      const seen = new Set<unknown>();
      for (const [index, value] of values.entries()) {
        if (seen.has(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index],
            message: `duplicate entry: ${String(value)}`,
          });
        }
        seen.add(value);
      }
    })
    .default([]);
}

const contributionName = z.string().regex(CONTRIBUTION_NAME);

export const NativePluginManifest = z
  .object({
    schemaVersion: z.literal(2),
    /** The `ctx` contract the plugin was written against. */
    apiVersion: z.number().int().min(1).max(1_000),
    /** ESM entry, relative to the plugin root. */
    main: z
      .string()
      .max(256)
      .regex(MAIN_ENTRY)
      .refine((value) => !value.split("/").includes(".."), {
        message: "main must stay inside the plugin directory",
      }),
    contributes: z
      .object({
        hooks: uniqueList(z.enum(NATIVE_HOOK_EVENTS), NATIVE_HOOK_EVENTS.length),
        tools: uniqueList(z.string().max(32).regex(TOOL_NAME), 64),
        presets: uniqueList(contributionName, 16),
        promptSections: uniqueList(contributionName, 32),
        context: uniqueList(contributionName, 16),
        background: z.boolean().default(false),
      })
      .strict()
      .default({}),
    coreCapabilities: uniqueList(z.string().regex(CAPABILITY_NAME), 16),
    hostCapabilities: uniqueList(z.string().regex(CAPABILITY_NAME), 32),
    /** A Panel App this plugin works with. A soft link: it is installed and approved separately. */
    companionPanel: z.string().regex(CONTRIBUTION_NAME).optional(),
    automations: PluginAutomationsManifest.optional(),
  })
  .strict();

export type NativePluginManifest = z.infer<typeof NativePluginManifest>;

export type NativeManifestRead =
  | { kind: "none" }
  | { kind: "invalid"; error: string }
  | { kind: "native"; manifest: NativePluginManifest };

function readBounded(path: string): Buffer | null | Error {
  let fd: number | undefined;
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      return new Error(`${NATIVE_PLUGIN_MANIFEST_FILE} must be a regular file`);
    }
    if (info.size > MAX_MANIFEST_BYTES) {
      return new Error(`${NATIVE_PLUGIN_MANIFEST_FILE} exceeds ${MAX_MANIFEST_BYTES} bytes`);
    }
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_MANIFEST_BYTES) {
      return new Error(`${NATIVE_PLUGIN_MANIFEST_FILE} must be a regular bounded file`);
    }
    const bytes = Buffer.allocUnsafe(opened.size);
    let total = 0;
    while (total < bytes.length) {
      const read = readSync(fd, bytes, total, bytes.length - total, null);
      if (read === 0) break;
      total += read;
    }
    return bytes.subarray(0, total);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : (error as Error);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
    .join("; ");
}

/** Parse an already-decoded manifest document. `none` means "not a native plugin". */
export function parseNativePluginManifest(raw: unknown): NativeManifestRead {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { kind: "invalid", error: "manifest must be an object" };
  }
  const schemaVersion = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (schemaVersion === 1) return { kind: "none" };
  if (schemaVersion !== 2) {
    return {
      kind: "invalid",
      error: `unsupported schemaVersion ${JSON.stringify(schemaVersion)}; this CodeShell reads 1 and 2`,
    };
  }
  const parsed = NativePluginManifest.safeParse(raw);
  return parsed.success
    ? { kind: "native", manifest: parsed.data }
    : { kind: "invalid", error: describeIssues(parsed.error) };
}

/**
 * Read the native manifest of one plugin tree. The entry file itself must be
 * a regular file inside the tree: a symlinked `main` would let the code that
 * runs differ from the bytes the tree digest covers.
 */
export function readNativePluginManifest(root: string): NativeManifestRead {
  const bytes = readBounded(join(root, NATIVE_PLUGIN_MANIFEST_FILE));
  if (bytes === null) return { kind: "none" };
  if (bytes instanceof Error) return { kind: "invalid", error: bytes.message };
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    return {
      kind: "invalid",
      error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const read = parseNativePluginManifest(raw);
  if (read.kind !== "native") return read;
  try {
    let directory = root;
    const segments = read.manifest.main.replace(/^\.\//, "").split("/");
    for (const [index, segment] of segments.entries()) {
      directory = join(directory, segment);
      const info = lstatSync(directory);
      const last = index === segments.length - 1;
      if (info.isSymbolicLink() || (last ? !info.isFile() : !info.isDirectory())) {
        return { kind: "invalid", error: `main "${read.manifest.main}" must be a regular file` };
      }
    }
  } catch {
    return { kind: "invalid", error: `main "${read.manifest.main}" does not exist` };
  }
  return read;
}

// ─── Public names ────────────────────────────────────────────────

export function isNativePluginName(plugin: string): boolean {
  return PLUGIN_NAME.test(plugin);
}

/** `plugin__<plugin>__<tool>`: what the model sees and what permission rules name. */
export function nativeToolName(plugin: string, tool: string): string {
  return `plugin__${plugin}__${tool}`;
}

/** `<plugin>:<name>`: presets and prompt sections. */
export function nativeScopedName(plugin: string, name: string): string {
  return `${plugin}:${name}`;
}

/** `plugin-<plugin>-<name>`: the context ledger only accepts lower-case letters, digits and dashes. */
export function nativeContextKey(plugin: string, name: string): string {
  return `plugin-${plugin}-${name}`;
}

/** Stable per install: two marketplaces may both ship a plugin of the same name. */
export function nativeModuleId(plugin: string, installKey: string): string {
  return `plugin-${plugin}-${createHash("sha256").update(installKey).digest("hex").slice(0, 8)}`;
}

/** Everything about a plugin's names that the manifest schema cannot check on its own. */
export function nativeNamingProblem(plugin: string, manifest: NativePluginManifest): string | null {
  if (!isNativePluginName(plugin)) {
    return `a native plugin's name must match ${PLUGIN_NAME.source}; "${plugin}" does not`;
  }
  const tooLong = manifest.contributes.tools.find(
    (tool) => nativeToolName(plugin, tool).length > MAX_PUBLIC_TOOL_NAME,
  );
  return tooLong
    ? `tool "${tooLong}" becomes "${nativeToolName(plugin, tooLong)}", longer than ${MAX_PUBLIC_TOOL_NAME} characters`
    : null;
}

// ─── Reviewable surface ──────────────────────────────────────────

/** What the user approves, as plain sorted data. Never contains code or prompt text. */
export interface NativePluginSurface {
  apiVersion: number;
  hooks: string[];
  tools: string[];
  presets: string[];
  promptSections: string[];
  context: string[];
  background: boolean;
  coreCapabilities: string[];
  hostCapabilities: string[];
  companionPanel?: string;
}

export function nativePluginSurface(manifest: NativePluginManifest): NativePluginSurface {
  const sorted = (values: readonly string[]) => [...values].sort();
  return {
    apiVersion: manifest.apiVersion,
    hooks: sorted(manifest.contributes.hooks),
    tools: sorted(manifest.contributes.tools),
    presets: sorted(manifest.contributes.presets),
    promptSections: sorted(manifest.contributes.promptSections),
    context: sorted(manifest.contributes.context),
    background: manifest.contributes.background,
    coreCapabilities: sorted(manifest.coreCapabilities),
    hostCapabilities: sorted(manifest.hostCapabilities),
    ...(manifest.companionPanel ? { companionPanel: manifest.companionPanel } : {}),
  };
}

export const NATIVE_SURFACE_LISTS = [
  "hooks",
  "tools",
  "presets",
  "promptSections",
  "context",
  "coreCapabilities",
  "hostCapabilities",
] as const;
export type NativeSurfaceList = (typeof NATIVE_SURFACE_LISTS)[number];

export interface NativeSurfaceDiff {
  added: Partial<Record<NativeSurfaceList, string[]>>;
  removed: Partial<Record<NativeSurfaceList, string[]>>;
  /** Set when the plugin started or stopped running background logic. */
  background?: { from: boolean; to: boolean };
}

/** What changed since the surface the user last approved. No baseline means everything is new. */
export function diffNativeSurface(
  previous: NativePluginSurface | undefined,
  current: NativePluginSurface,
): NativeSurfaceDiff {
  const diff: NativeSurfaceDiff = { added: {}, removed: {} };
  for (const list of NATIVE_SURFACE_LISTS) {
    const before = new Set(previous?.[list] ?? []);
    const after = new Set(current[list]);
    const added = current[list].filter((value) => !before.has(value));
    const removed = [...before].filter((value) => !after.has(value));
    if (added.length > 0) diff.added[list] = added;
    if (removed.length > 0) diff.removed[list] = removed;
  }
  const from = previous?.background ?? false;
  if (from !== current.background) diff.background = { from, to: current.background };
  return diff;
}
