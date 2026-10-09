import { isAbsolute, resolve } from "node:path";
import { TOOL_HOOK_EVENTS } from "../hooks/configured-tool-hooks.js";
import type { PluginHookSource } from "../plugins/loadPluginHooks.js";
import { isSnapshotName, validateResourceLayout } from "../runtime/constrained-process/layout.js";
import { sha256 } from "../runtime/constrained-process/resources.js";
import type {
  ConstrainedDockerRuntime,
  ConstrainedProcessLaunch,
} from "../runtime/constrained-process/types.js";
import type { OperationHookContext } from "./operation-hooks.js";

export interface SettingsPlanSource {
  kind: "settings";
  layer: "managed" | "user" | "project" | "local";
  path: string;
  rawSha256: string;
  sourceLayerIndex: number;
  definitionSha256: string;
}

export interface NativeHookResourcePlan {
  commandSha256: string;
  event: (typeof TOOL_HOOK_EVENTS)[number];
  source: SettingsPlanSource | PluginHookSource;
  context: OperationHookContext;
  definitionCwd: string | null;
  files: Array<{ source: string; name: string; bytes: number; sha256: string }>;
  directories: string[];
  launch: Omit<ConstrainedProcessLaunch, "planSha256">;
  planSha256: string;
}

const invalid = () => new Error("Invalid operation Hook Host configuration");
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, any>;
}
function keys(value: unknown, required: string[], optional: string[] = []) {
  const object = record(value);
  if (
    required.some((key) => !Object.hasOwn(object, key)) ||
    Object.keys(object).some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw invalid();
  return object;
}
function text(value: unknown, limit: number): value is string {
  return typeof value === "string" && !value.includes("\0") && Buffer.byteLength(value) <= limit;
}
function hostPath(value: unknown): value is string {
  return text(value, 4096) && isAbsolute(value) && resolve(value) === value;
}

function canonical(value: unknown): string {
  const ordered = (item: any): any =>
    Array.isArray(item)
      ? item.map(ordered)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, ordered(item[key])]),
          )
        : item;
  return JSON.stringify(ordered(value));
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Pure bounded parsing. Appearing in a plan never opens or scans a source. */
export function parseOperationHookHost(configuration: string) {
  if (Buffer.byteLength(configuration) > 32768) throw invalid();
  const parsed = keys(
    JSON.parse(configuration),
    ["runtime", "inlineCommandSha256"],
    ["resourcePlans"],
  );
  const runtime = keys(parsed.runtime, [
    "executable",
    "executableSha256",
    "endpoint",
    "image",
    "architecture",
    "nodeExecutable",
    "nodeExecutableSha256",
  ]);
  if (
    !Object.values(runtime).every((value) => typeof value === "string") ||
    !Array.isArray(parsed.inlineCommandSha256) ||
    parsed.inlineCommandSha256.length > 256 ||
    !parsed.inlineCommandSha256.every(digest) ||
    (parsed.resourcePlans !== undefined && !Array.isArray(parsed.resourcePlans)) ||
    (parsed.resourcePlans?.length ?? 0) > 16
  )
    throw invalid();
  const inline = new Set<string>(parsed.inlineCommandSha256);
  const plans: NativeHookResourcePlan[] = [];
  const unique = new Set<string>();
  let fileCount = 0;
  let directoryCount = 0;
  let byteCount = 0;
  for (const input of parsed.resourcePlans ?? []) {
    const plan = keys(input, [
      "commandSha256",
      "event",
      "source",
      "context",
      "definitionCwd",
      "files",
      "directories",
      "launch",
    ]);
    if (
      !digest(plan.commandSha256) ||
      inline.has(plan.commandSha256) ||
      !TOOL_HOOK_EVENTS.includes(plan.event) ||
      (plan.definitionCwd !== null && !text(plan.definitionCwd, 4096)) ||
      !Array.isArray(plan.files) ||
      plan.files.length > 64 ||
      !Array.isArray(plan.directories) ||
      plan.directories.length > 64
    )
      throw invalid();
    const context = keys(plan.context, ["cwd", "settingsScope", "profileName"]);
    if (
      !text(context.cwd, 4096) ||
      !isAbsolute(context.cwd) ||
      !["full", "project", "isolated"].includes(context.settingsScope) ||
      (context.profileName !== null && !text(context.profileName, 256))
    )
      throw invalid();
    const source = record(plan.source);
    if (source.kind === "settings") {
      keys(source, ["kind", "layer", "path", "rawSha256", "sourceLayerIndex", "definitionSha256"]);
      if (
        !["managed", "user", "project", "local"].includes(source.layer) ||
        !hostPath(source.path) ||
        !digest(source.rawSha256) ||
        !digest(source.definitionSha256) ||
        !Number.isSafeInteger(source.sourceLayerIndex) ||
        source.sourceLayerIndex < 0
      )
        throw invalid();
    } else if (source.kind === "plugin") {
      keys(source, [
        "kind",
        "installKey",
        "installPath",
        "installEntrySha256",
        "hooksDigest",
        "approval",
        "approvedHookDigest",
        "rawEvent",
        "key",
      ]);
      if (
        !text(source.installKey, 256) ||
        !source.installKey ||
        !hostPath(source.installPath) ||
        !digest(source.installEntrySha256) ||
        !digest(source.hooksDigest) ||
        !["approved", "legacy"].includes(source.approval) ||
        (source.approvedHookDigest !== null && !digest(source.approvedHookDigest)) ||
        !text(source.rawEvent, 128) ||
        !source.rawEvent ||
        !text(source.key, 32768) ||
        !source.key
      )
        throw invalid();
    } else throw invalid();
    const files = plan.files.map((file: unknown) => {
      const value = keys(file, ["source", "name", "bytes", "sha256"]);
      if (
        !(source.kind === "plugin" ? isSnapshotName(value.source) : hostPath(value.source)) ||
        !isSnapshotName(value.name) ||
        !digest(value.sha256) ||
        !Number.isSafeInteger(value.bytes) ||
        value.bytes < 0 ||
        value.bytes > 8 * 1024 * 1024
      )
        throw invalid();
      byteCount += value.bytes;
      return { source: value.source, name: value.name, bytes: value.bytes, sha256: value.sha256 };
    });
    const directories = validateResourceLayout(
      files.map((file) => file.name),
      plan.directories,
    );
    const launch = keys(plan.launch, ["interpreter", "entry", "argv"], ["cwd"]);
    if (
      !["node", "sh"].includes(launch.interpreter) ||
      !isSnapshotName(launch.entry) ||
      !files.some((file) => file.name === launch.entry) ||
      !Array.isArray(launch.argv) ||
      launch.argv.length > 32 ||
      !launch.argv.every((arg: unknown) => text(arg, 1024)) ||
      launch.argv.reduce((sum: number, arg: string) => sum + Buffer.byteLength(arg), 0) > 8192 ||
      (launch.cwd !== undefined && launch.cwd !== "." && !directories.includes(launch.cwd))
    )
      throw invalid();
    fileCount += files.length;
    directoryCount += directories.length;
    if (fileCount > 256 || directoryCount > 256 || byteCount > 32 * 1024 * 1024) throw invalid();
    const normalized: Omit<NativeHookResourcePlan, "planSha256"> = {
      commandSha256: plan.commandSha256,
      event: plan.event,
      source: { ...source } as unknown as NativeHookResourcePlan["source"],
      context: { ...context } as OperationHookContext,
      definitionCwd: plan.definitionCwd,
      files,
      directories,
      launch: {
        interpreter: launch.interpreter,
        entry: launch.entry,
        argv: [...launch.argv],
        ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
      },
    };
    const identity = canonical([
      normalized.commandSha256,
      normalized.event,
      normalized.source,
      normalized.context,
      normalized.definitionCwd,
    ]);
    if (unique.has(identity)) throw invalid();
    unique.add(identity);
    plans.push(
      freeze({
        ...normalized,
        planSha256: sha256(`codeshell-hook-resource-plan-v1\0${canonical(normalized)}`),
      } as NativeHookResourcePlan),
    );
  }
  return { runtime: { ...runtime } as ConstrainedDockerRuntime, inline, plans };
}
