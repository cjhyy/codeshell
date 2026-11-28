/**
 * Messages between the agent worker and one native plugin process.
 *
 * The channel is the Node IPC descriptor created by `fork`: structured JSON
 * messages, separate from the child's stdout/stderr (which are only ever
 * treated as log text). Everything that crosses it is plain data. A plugin's
 * handlers stay in its own process; the worker only ever learns their names.
 *
 * This file is imported by the child entry, so it must stay free of imports
 * from the rest of core: the child loads nothing of the engine.
 */

/** Bumped together with CONTRACTS.pluginApi. */
export const PLUGIN_PROTOCOL_VERSION = 1;

/** Hard cap for one message in either direction, measured as JSON text. */
export const MAX_PLUGIN_MESSAGE_BYTES = 1024 * 1024;

export const DEFAULT_HOOK_TIMEOUT_MS = 5_000;
export const MAX_HOOK_TIMEOUT_MS = 60_000;
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
export const MAX_TOOL_TIMEOUT_MS = 600_000;
export const CONTEXT_TIMEOUT_MS = 2_000;
export const SETUP_TIMEOUT_MS = 10_000;
export const PING_TIMEOUT_MS = 2_000;
/**
 * How long a plugin's background logic gets to clean up once it is stopped.
 * Shorter than the worker's grace before it kills a process that does not leave.
 */
export const EFFECT_CLEANUP_MS = 1_500;

/** Events whose handler may ask to fail closed when the plugin cannot answer. */
export const DENY_ON_ERROR_EVENTS = ["pre_tool_use", "on_permission_check"] as const;

export type PluginInvocationKind = "hook" | "tool" | "context";

export interface NativeHookDeclaration {
  event: string;
  timeoutMs: number;
  /** What an unanswered call means: no result, or (policy plugins) a denial. */
  onError: "ignore" | "deny";
}

export interface NativeToolDeclaration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  concurrencySafe: boolean;
  timeoutMs: number;
  /** "preset": follows preset membership. "always": visible in every preset. */
  exposure: "preset" | "always";
}

export interface NativePermissionRule {
  tool: string;
  decision: "allow" | "deny" | "ask";
  reason?: string;
}

export interface NativePresetDeclaration {
  name: string;
  label: string;
  description: string;
  promptSections: string[];
  /** The plugin's own tools by short name, built-in tools by their name. */
  builtinTools: string[];
  defaultPermissionRules: NativePermissionRule[];
}

export interface NativePresetExtensionDeclaration {
  target: { presets: string[] } | { allExcept: string[] };
  tools: string[];
}

/** Everything a plugin registered in `setup`, as data. */
export interface NativeDeclarations {
  hooks: NativeHookDeclaration[];
  tools: NativeToolDeclaration[];
  presets: NativePresetDeclaration[];
  presetExtensions: NativePresetExtensionDeclaration[];
  promptSections: Array<{ name: string; text: string }>;
  context: Array<{ name: string }>;
  background: boolean;
}

export interface PluginProcessInit {
  t: "init";
  protocol: number;
  apiVersion: number;
  plugin: { name: string; installKey: string; root: string; main: string; dataDir: string };
  host: { kind: string };
}

export type WorkerToPluginMessage =
  | PluginProcessInit
  | { t: "invoke"; id: number; kind: PluginInvocationKind; name: string; payload: unknown }
  | { t: "cancel"; id: number }
  | { t: "background"; run: boolean }
  | { t: "ping"; id: number };

export interface PluginErrorPayload {
  code: string;
  message: string;
}

export type PluginToWorkerMessage =
  | { t: "ready"; declarations: NativeDeclarations }
  | { t: "failed"; error: string }
  | { t: "result"; id: number; ok: true; value: unknown }
  | { t: "result"; id: number; ok: false; error: PluginErrorPayload }
  | { t: "pong"; id: number }
  | { t: "log"; level: "debug" | "info" | "warn" | "error"; message: string }
  /** Answers `background` with `run: false` once every cleanup has run. */
  | { t: "background-stopped" };

// What a plugin's handlers receive and return; type-only, so nothing is loaded.
export type {
  PluginContextCall,
  PluginHookEvent,
  PluginHookReply,
  PluginToolCall,
  PluginToolReply,
} from "../plugin-sdk.js";

/** Whether a decoded value fits in one message. Used on both sides before sending. */
export function fitsPluginMessage(value: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") <= MAX_PLUGIN_MESSAGE_BYTES;
  } catch {
    return false;
  }
}
