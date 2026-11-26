/**
 * Native plugin API, version 1: what a plugin's entry receives and returns.
 *
 * A native plugin is an installed plugin whose `.codeshell-plugin/plugin.json`
 * has `schemaVersion: 2` and names a `main` ES module. That module's default
 * export is `definePlugin({ setup })` (or a bare setup function). CodeShell
 * runs it in a process of its own, from a verified read-only copy of the
 * plugin directory, after the user approved the plugin.
 *
 * Everything is registered during `setup`, and only what the manifest's
 * `contributes` announced is accepted. Handlers stay in the plugin's process;
 * the agent only learns their names and calls them with plain JSON data.
 *
 * This file has no imports: bundling `definePlugin` brings nothing else of
 * CodeShell along, and a plugin that does not bundle can use `import type`.
 */

export const PLUGIN_API_VERSION = 1;

/** Engine events a plugin may handle. */
export type PluginHookEventName =
  | "on_agent_start"
  | "on_agent_end"
  | "on_turn_start"
  | "on_turn_end"
  | "on_stop"
  | "on_tool_start"
  | "on_tool_end"
  | "on_permission_check"
  | "on_session_start"
  | "on_session_end"
  | "pre_tool_use"
  | "post_tool_use"
  | "user_prompt_submit"
  | "agent_direction_submit"
  | "pre_compact"
  | "post_compact"
  | "file_changed"
  | "notification";

/** The event a hook handler receives. `data` is a copy of the engine's event data. */
export interface PluginHookEvent {
  name: string;
  sessionId?: string;
  /** Set for a sub-agent: the top-level Session that spawned it. */
  parentSessionId?: string;
  /** Working directory of the top-level Session, when the host knows it. */
  cwd?: string;
  preset?: string;
  isSubAgent: boolean;
  data: Record<string, unknown>;
}

/**
 * What a hook may answer. Each event keeps only what it lets a plugin change:
 * - `pre_tool_use`: `decision` ("deny" or "ask"), `messages`, `updatedInput`.
 * - `on_permission_check`: `decision`, `messages`.
 * - `user_prompt_submit`, `agent_direction_submit`: `messages`, `updatedPrompt`.
 * - `post_tool_use`: `additionalContext`.
 * - `on_stop`: `continueSession`, `messages`.
 * - `on_session_start`, `on_turn_start`, `post_compact`: `messages`.
 * - every other event: nothing; it is an observation.
 * A hook can tighten a permission decision, never grant one.
 */
export interface PluginHookReply {
  decision?: "deny" | "ask";
  messages?: string[];
  updatedInput?: Record<string, unknown>;
  updatedPrompt?: string;
  additionalContext?: string;
  continueSession?: boolean;
}

export interface PluginHookOptions {
  /** Default 5 s, at most 60 s. */
  timeoutMs?: number;
  /**
   * What happens when the plugin cannot answer in time or at all. "deny" is
   * for policy plugins and only allowed on `pre_tool_use` and
   * `on_permission_check`: the tool call is refused.
   */
  onError?: "ignore" | "deny";
}

export interface PluginToolCall {
  input: Record<string, unknown>;
  sessionId?: string;
  cwd?: string;
}

export interface PluginToolReply {
  content: string;
  isError?: boolean;
}

export interface PluginCallOptions {
  /** Aborted when the call is cancelled or runs out of time. */
  signal: AbortSignal;
}

export interface PluginToolDefinition {
  /** Lower-case letters, digits and single underscores. The model sees `plugin__<plugin>__<name>`. */
  name: string;
  description: string;
  /** JSON Schema of the input object. */
  inputSchema?: Record<string, unknown>;
  readOnly?: boolean;
  concurrencySafe?: boolean;
  /** Default 120 s, at most 600 s. */
  timeoutMs?: number;
  /** "preset" (default) follows preset membership; "always" is visible in every preset. */
  exposure?: "preset" | "always";
  execute(
    call: PluginToolCall,
    options: PluginCallOptions,
  ): PluginToolReply | string | Promise<PluginToolReply | string>;
}

export interface PluginPresetDefinition {
  /** The preset is offered as `<plugin>:<name>`. */
  name: string;
  label?: string;
  description?: string;
  /** This plugin's sections by short name, the host's by their name. */
  promptSections?: string[];
  /** This plugin's tools by short name, built-in tools by their name. */
  builtinTools?: string[];
  /** Rules can ask or deny; a plugin cannot pre-approve anything. */
  defaultPermissionRules?: Array<{ tool: string; decision: "deny" | "ask"; reason?: string }>;
}

export interface PluginContextCall {
  sessionId?: string;
  cwd: string;
  preset: string;
  isSubAgent: boolean;
}

export type PluginContextProvider = (
  call: PluginContextCall,
  options: PluginCallOptions,
) =>
  | string
  | { text?: string }
  | null
  | undefined
  | Promise<string | { text?: string } | null | undefined>;

/** Runs while the plugin is loaded; may return a cleanup function. */
export type PluginEffect = (
  signal: AbortSignal,
) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;

export interface PluginContext {
  readonly plugin: {
    readonly name: string;
    readonly installKey: string;
    /** The verified, read-only copy the plugin runs from. */
    readonly root: string;
    /** A directory the plugin may write to; it survives updates. */
    readonly dataDir: string;
    readonly apiVersion: number;
  };
  /** Goes to the plugin's log file, which the user can read. So does stdout. */
  readonly log: {
    debug(...parts: unknown[]): void;
    info(...parts: unknown[]): void;
    warn(...parts: unknown[]): void;
    error(...parts: unknown[]): void;
  };
  readonly hooks: {
    on(
      event: PluginHookEventName,
      handler: (
        event: PluginHookEvent,
        options: PluginCallOptions,
      ) => PluginHookReply | void | Promise<PluginHookReply | void>,
      options?: PluginHookOptions,
    ): void;
  };
  readonly tools: {
    register(tool: PluginToolDefinition): void;
  };
  readonly presets: {
    add(preset: PluginPresetDefinition): void;
    /** Add this plugin's preset tools to presets of the host or of this plugin. */
    extend(target: string | string[] | { allExcept: string[] }, tools: string[]): void;
  };
  readonly prompt: {
    /** Static text, offered as section `<plugin>:<name>`. */
    section(name: string, text: string): void;
  };
  readonly context: {
    /** Text the model sees as its own context section, asked for at each turn. */
    provide(name: string, provider: PluginContextProvider): void;
  };
  /** Background logic. Needs `contributes.background` in the manifest. */
  effect(effect: PluginEffect): void;
  /**
   * Capabilities a plugin declares in `coreCapabilities` and `hostCapabilities`.
   * API version 1 grants none of them yet: `has` answers false.
   */
  readonly core: { has(name: string): boolean };
  readonly host: { readonly kind: string; has(name: string): boolean };
}

export type PluginSetup = (ctx: PluginContext) => void | Promise<void>;

export interface PluginDefinition {
  setup: PluginSetup;
}

/** Identity at runtime; gives the plugin's entry its types. */
export function definePlugin<T extends PluginDefinition>(definition: T): T {
  return definition;
}
