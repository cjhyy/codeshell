/**
 * Turns what a native plugin registered into an ordinary engine-only
 * AgentModule. Every function in that module is a forwarding stub: the engine
 * calls it like any hook or tool, the stub sends the call to the plugin's
 * process and translates the answer back.
 *
 * This is also where the plugin's answers stop being trusted: only the fields
 * an event allows are kept, names are prefixed, and a plugin that cannot
 * answer falls back to the failure policy it registered.
 */

import { createHash } from "node:crypto";
import type {
  CapabilityDynamicContextProvider,
  CapabilityEngineHookContribution,
} from "../capabilities/index.js";
import type {
  AgentModule,
  AgentModuleToolContribution,
  AgentPresetExtension,
} from "../composition/types.js";
import type { HookContext, HookEventName, HookResult } from "../hooks/events.js";
import {
  NATIVE_HOOK_EVENTS,
  nativeContextKey,
  nativeScopedName,
  nativeToolName,
  type NativePluginManifest,
} from "../plugins/native/manifest.js";
import type { AgentPreset } from "../preset/index.js";
import type { ToolContext } from "../tool-system/context.js";
import type { RegisteredTool } from "../types.js";
import { PluginCallError } from "./process.js";
import {
  CONTEXT_TIMEOUT_MS,
  DENY_ON_ERROR_EVENTS,
  MAX_HOOK_TIMEOUT_MS,
  MAX_TOOL_TIMEOUT_MS,
  type NativeDeclarations,
  type NativeHookDeclaration,
  type NativeToolDeclaration,
  type PluginHookEvent,
  type PluginInvocationKind,
} from "./protocol.js";

/** Same tier as command hooks from installed plugins; user settings hooks run after it. */
export const NATIVE_HOOK_PRIORITY = 80;
const MAX_HOOK_MESSAGES = 16;
const MAX_HOOK_MESSAGE_CHARS = 16_384;
const MAX_ADDITIONAL_CONTEXT_CHARS = 65_536;
const MAX_REWRITTEN_PROMPT_CHARS = 262_144;
const MAX_CONTEXT_CHARS = 16_384;
const MAX_PROMPT_SECTION_CHARS = 32_768;
const MAX_TOOL_DESCRIPTION_CHARS = 4_096;

export type NativeCallBlock = "revoked" | "disabled";

/** How the stubs reach the plugin. Implemented by the runtime's per-plugin slot. */
export interface NativePluginCalls {
  invoke(
    kind: PluginInvocationKind,
    name: string,
    payload: unknown,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown>;
  /**
   * Set when calls from this session must not reach the plugin at all. Takes
   * the top-level Session: a sub-agent follows the Session that spawned it.
   */
  blocked(sessionId: string | undefined): NativeCallBlock | undefined;
  sessionCwd(sessionId: string | undefined): string | undefined;
}

/** A JSON-safe copy: plain objects, arrays and primitives survive; everything else is dropped. */
export function plainData(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "object" || depth > 32) return undefined;
  if (Array.isArray(value)) return value.map((item) => plainData(item, depth + 1) ?? null);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const copied = plainData(item, depth + 1);
    if (copied !== undefined) out[key] = copied;
  }
  return out;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/**
 * Identity of everything the model and the engine can observe about a plugin.
 * Equal digests mean a new process can take over without rebuilding anything.
 */
export function nativeDeclarationsDigest(declarations: NativeDeclarations): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(declarations)))
    .digest("hex");
}

function outside(declared: readonly string[], allowed: readonly string[]): string | undefined {
  return declared.find((name) => !allowed.includes(name));
}

function duplicate(names: readonly string[]): string | undefined {
  return names.find((name, index) => names.indexOf(name) !== index);
}

function wholeMillis(value: unknown, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;
}

/**
 * The authoritative check of what a plugin registered. The plugin process
 * produced these declarations: normally through the SDK, but the plugin's own
 * code runs in that process and can answer the handshake itself. So nothing
 * in them is assumed well-formed, limits the SDK applies are checked again,
 * and a shape that breaks the check is a problem, not a crash. Returns the
 * first problem, or null.
 */
export function validateNativeDeclarations(
  manifest: NativePluginManifest,
  declarations: NativeDeclarations,
): string | null {
  try {
    return firstProblem(manifest, declarations);
  } catch (error) {
    return `malformed declarations: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function firstProblem(
  manifest: NativePluginManifest,
  declarations: NativeDeclarations,
): string | null {
  const contributes = manifest.contributes;
  if (!declarations || typeof declarations !== "object") return "setup returned no declarations";
  for (const list of [
    "hooks",
    "tools",
    "presets",
    "presetExtensions",
    "promptSections",
    "context",
  ] as const) {
    if (!Array.isArray(declarations[list])) return `declarations.${list} is not a list`;
  }

  const events = declarations.hooks.map((hook) => hook?.event);
  const unknownEvent = events.find(
    (event) => !(NATIVE_HOOK_EVENTS as readonly string[]).includes(event),
  );
  if (unknownEvent !== undefined) return `unknown hook event "${String(unknownEvent)}"`;
  const undeclaredHook = outside(events, contributes.hooks);
  if (undeclaredHook) return `hook "${undeclaredHook}" is not declared in the manifest`;
  if (duplicate(events)) return `hook "${duplicate(events)}" is registered twice`;
  const badPolicy = declarations.hooks.find(
    (hook) =>
      hook.onError === "deny" && !(DENY_ON_ERROR_EVENTS as readonly string[]).includes(hook.event),
  );
  if (badPolicy) return `hook "${badPolicy.event}" cannot fail closed; only tool gates can`;
  for (const hook of declarations.hooks) {
    if (!wholeMillis(hook.timeoutMs, MAX_HOOK_TIMEOUT_MS)) {
      return `hook "${hook.event}" needs a timeout of 1 to ${MAX_HOOK_TIMEOUT_MS} ms`;
    }
    if (hook.onError !== "ignore" && hook.onError !== "deny") {
      return `hook "${hook.event}" has an unknown error policy`;
    }
  }

  const tools = declarations.tools.map((tool) => tool?.name);
  const undeclaredTool = outside(tools, contributes.tools);
  if (undeclaredTool) return `tool "${undeclaredTool}" is not declared in the manifest`;
  if (duplicate(tools)) return `tool "${duplicate(tools)}" is registered twice`;
  for (const tool of declarations.tools) {
    if (typeof tool.description !== "string" || !tool.description.trim()) {
      return `tool "${tool.name}" needs a description`;
    }
    if (tool.description.length > MAX_TOOL_DESCRIPTION_CHARS) {
      return `tool "${tool.name}" has a description longer than ${MAX_TOOL_DESCRIPTION_CHARS} characters`;
    }
    if (
      !tool.inputSchema ||
      typeof tool.inputSchema !== "object" ||
      Array.isArray(tool.inputSchema)
    ) {
      return `tool "${tool.name}" needs an object input schema`;
    }
    if (!wholeMillis(tool.timeoutMs, MAX_TOOL_TIMEOUT_MS)) {
      return `tool "${tool.name}" needs a timeout of 1 to ${MAX_TOOL_TIMEOUT_MS} ms`;
    }
    if (tool.exposure !== "preset" && tool.exposure !== "always") {
      return `tool "${tool.name}" has an unknown exposure`;
    }
    if (typeof tool.readOnly !== "boolean" || typeof tool.concurrencySafe !== "boolean") {
      return `tool "${tool.name}" needs readOnly and concurrencySafe flags`;
    }
  }

  const sections = declarations.promptSections.map((section) => section?.name);
  const undeclaredSection = outside(sections, contributes.promptSections);
  if (undeclaredSection)
    return `prompt section "${undeclaredSection}" is not declared in the manifest`;
  if (duplicate(sections)) return `prompt section "${duplicate(sections)}" is registered twice`;
  const longSection = declarations.promptSections.find(
    (section) => typeof section.text !== "string" || section.text.length > MAX_PROMPT_SECTION_CHARS,
  );
  if (longSection) {
    return `prompt section "${longSection.name}" must be text of at most ${MAX_PROMPT_SECTION_CHARS} characters`;
  }

  const contexts = declarations.context.map((context) => context?.name);
  const undeclaredContext = outside(contexts, contributes.context);
  if (undeclaredContext) return `context "${undeclaredContext}" is not declared in the manifest`;
  if (duplicate(contexts)) return `context "${duplicate(contexts)}" is registered twice`;

  if (declarations.background && !contributes.background) {
    return "background logic is not declared in the manifest";
  }

  const presets = declarations.presets.map((preset) => preset?.name);
  const undeclaredPreset = outside(presets, contributes.presets);
  if (undeclaredPreset) return `preset "${undeclaredPreset}" is not declared in the manifest`;
  if (duplicate(presets)) return `preset "${duplicate(presets)}" is registered twice`;
  const presetTools = new Set(
    declarations.tools.filter((tool) => tool.exposure !== "always").map((tool) => tool.name),
  );
  for (const preset of declarations.presets) {
    // Another plugin's tools are off limits: a plugin must keep loading when
    // any other plugin is removed.
    const foreign = preset.builtinTools.find((tool) => tool.startsWith("plugin__"));
    if (foreign) return `preset "${preset.name}" references another plugin's tool "${foreign}"`;
    // Plugins may tighten what a preset allows, never loosen it. Shipping an
    // allow rule would let a plugin lower the confirmation bar for itself.
    const allow = preset.defaultPermissionRules.find((rule) => rule.decision === "allow");
    if (allow) return `preset "${preset.name}" carries an allow rule for "${allow.tool}"`;
  }
  for (const extension of declarations.presetExtensions) {
    const notOwn = extension.tools.find((tool) => !presetTools.has(tool));
    if (notOwn)
      return `a preset extension adds "${notOwn}", which is not a preset tool of this plugin`;
  }
  return null;
}

function abortSignal(value: unknown): AbortSignal | undefined {
  return value instanceof AbortSignal ? value : undefined;
}

function textOf(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

function messagesOf(plugin: string, value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const messages = value
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .slice(0, MAX_HOOK_MESSAGES)
    // The model and the user should be able to tell who is speaking.
    .map((message) => `[${plugin}] ${message.slice(0, MAX_HOOK_MESSAGE_CHARS)}`);
  return messages.length > 0 ? messages : undefined;
}

const REMINDER_EVENTS: readonly HookEventName[] = [
  "on_session_start",
  "on_turn_start",
  "post_compact",
];

/**
 * Keep only what the event lets a plugin change. A plugin cannot stop the
 * chain, rewrite event data, end a goal run or approve anything: hooks can
 * only tighten a permission decision, and the executor enforces that again.
 */
export function hookResultFrom(event: HookEventName, plugin: string, reply: unknown): HookResult {
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) return {};
  const raw = reply as Record<string, unknown>;
  const result: HookResult = {};
  const messages = messagesOf(plugin, raw.messages);
  const decision = raw.decision === "deny" || raw.decision === "ask" ? raw.decision : undefined;

  if (event === "pre_tool_use" || event === "on_permission_check") {
    if (decision) result.decision = decision;
    if (messages) result.messages = messages;
    if (event === "pre_tool_use") {
      const input = plainData(raw.updatedInput);
      if (input && typeof input === "object" && !Array.isArray(input)) {
        result.updatedInput = input as Record<string, unknown>;
      }
    }
  } else if (event === "user_prompt_submit" || event === "agent_direction_submit") {
    if (messages) result.messages = messages;
    const prompt = textOf(raw.updatedPrompt, MAX_REWRITTEN_PROMPT_CHARS);
    if (prompt !== undefined) result.updatedPrompt = prompt;
  } else if (event === "post_tool_use") {
    const context = textOf(raw.additionalContext, MAX_ADDITIONAL_CONTEXT_CHARS);
    if (context !== undefined) result.additionalContext = `[${plugin}] ${context}`;
  } else if (event === "on_stop") {
    if (raw.continueSession === true) result.continueSession = true;
    if (messages) result.messages = messages;
  } else if (REMINDER_EVENTS.includes(event)) {
    if (messages) result.messages = messages;
  }
  return result;
}

function hookContribution(
  plugin: string,
  hook: NativeHookDeclaration,
  calls: NativePluginCalls,
): CapabilityEngineHookContribution {
  const event = hook.event as HookEventName;
  return {
    event,
    priority: NATIVE_HOOK_PRIORITY,
    name: `${plugin}:${event}`,
    handler: async (ctx: HookContext): Promise<HookResult> => {
      const sessionId = textOf(ctx.data.sessionId, 256);
      const owner = textOf(ctx.data.parentSessionId, 256) ?? sessionId;
      if (calls.blocked(owner)) return {};
      const {
        sessionId: _sessionId,
        parentSessionId: _parentSessionId,
        preset,
        isSubAgent,
        ...rest
      } = (plainData(ctx.data) ?? {}) as Record<string, unknown>;
      // Start from what earlier handlers in the chain already rewrote, so a
      // rewrite passes down the chain instead of being silently replaced.
      if (event === "pre_tool_use" && ctx.pending?.updatedInput !== undefined) {
        rest.args = plainData(ctx.pending.updatedInput);
      }
      if (
        (event === "user_prompt_submit" || event === "agent_direction_submit") &&
        typeof ctx.pending?.updatedPrompt === "string"
      ) {
        rest.prompt = ctx.pending.updatedPrompt;
      }
      // A sub-agent is only known through the Session that spawned it.
      const cwd = calls.sessionCwd(owner);
      const payload: PluginHookEvent = {
        name: event,
        ...(sessionId ? { sessionId } : {}),
        ...(owner && owner !== sessionId ? { parentSessionId: owner } : {}),
        ...(cwd ? { cwd } : {}),
        ...(typeof preset === "string" ? { preset } : {}),
        isSubAgent: isSubAgent === true,
        data: rest,
      };
      try {
        const reply = await calls.invoke("hook", event, payload, {
          timeoutMs: hook.timeoutMs,
          signal: abortSignal(ctx.data.signal),
        });
        return hookResultFrom(event, plugin, reply);
      } catch (error) {
        if (hook.onError !== "deny") return {};
        const code = error instanceof PluginCallError ? error.code : "ERROR";
        return {
          decision: "deny",
          messages: [`[${plugin}] the plugin could not answer (${code}); denied by its own policy`],
        };
      }
    },
  };
}

function toolFailure(plugin: string, tool: string, error: unknown): { ok: false; error: string } {
  const detail =
    error instanceof PluginCallError ? `${error.code}: ${error.message}` : String(error);
  return { ok: false, error: `Plugin "${plugin}" tool "${tool}" failed (${detail})` };
}

function toolContribution(
  plugin: string,
  tool: NativeToolDeclaration,
  calls: NativePluginCalls,
): AgentModuleToolContribution {
  const definition: RegisteredTool = {
    name: nativeToolName(plugin, tool.name),
    description: tool.description,
    inputSchema: tool.inputSchema,
    source: "builtin",
    // No rule of its own: the session's permission mode decides, as for any
    // tool the user has not written a rule for.
    permissionDefault: "ask",
    isReadOnly: tool.readOnly,
    isConcurrencySafe: tool.concurrencySafe,
    timeoutMs: tool.timeoutMs,
    // The tool does its own IO in its own process; the path layer cannot see it.
    pathPolicyExempt: true,
  };
  const execute = async (args: Record<string, unknown>, ctx?: ToolContext) => {
    const blocked = calls.blocked(ctx?.rootSessionId ?? ctx?.sessionId);
    if (blocked) {
      return {
        ok: false as const,
        error:
          blocked === "disabled"
            ? `Plugin "${plugin}" is disabled for this session.`
            : `Plugin "${plugin}" is no longer approved.`,
      };
    }
    try {
      const reply = await calls.invoke(
        "tool",
        tool.name,
        { input: plainData(args) ?? {}, sessionId: ctx?.sessionId, cwd: ctx?.cwd },
        { timeoutMs: tool.timeoutMs, signal: ctx?.signal },
      );
      if (typeof reply === "string") return { ok: true as const, result: reply };
      const content = (reply as { content?: unknown } | null)?.content;
      if (typeof content !== "string") {
        return toolFailure(plugin, tool.name, "the tool returned no text content");
      }
      return (reply as { isError?: unknown }).isError === true
        ? { ok: false as const, error: content }
        : { ok: true as const, result: content };
    } catch (error) {
      return toolFailure(plugin, tool.name, error);
    }
  };
  return tool.exposure === "always"
    ? { kind: "always", tool: { definition, execute } }
    : { kind: "preset-tags", tool: { definition, execute, exposure: { presetTags: [] } } };
}

function contextProvider(
  plugin: string,
  name: string,
  calls: NativePluginCalls,
): CapabilityDynamicContextProvider {
  const key = nativeContextKey(plugin, name);
  return async (context) => {
    const sessionId = context.session?.id;
    // No section at all withdraws whatever the plugin said before.
    if (calls.blocked(context.session?.parentId ?? sessionId)) return undefined;
    try {
      const reply = await calls.invoke(
        "context",
        name,
        {
          ...(sessionId ? { sessionId } : {}),
          cwd: context.cwd,
          preset: context.preset.name,
          isSubAgent: context.session?.isSubAgent === true,
        },
        { timeoutMs: CONTEXT_TIMEOUT_MS },
      );
      const text = textOf(
        typeof reply === "string" ? reply : (reply as { text?: unknown } | null)?.text,
        MAX_CONTEXT_CHARS,
      );
      return text === undefined ? undefined : { key, text };
    } catch {
      // A turn without an answer keeps what the model was last told; treating
      // it as a withdrawal would rewrite the context on every hiccup.
      return { key, unchanged: true };
    }
  };
}

export interface NativeModuleInput {
  moduleId: string;
  plugin: string;
  declarations: NativeDeclarations;
  calls: NativePluginCalls;
}

/** Build the module the composition compiler sees. Assumes validated declarations. */
export function buildNativeModule(input: NativeModuleInput): AgentModule {
  const { plugin, declarations, calls } = input;
  const ownTools = new Map(
    declarations.tools.map((tool) => [tool.name, nativeToolName(plugin, tool.name)]),
  );
  const ownSections = new Set(declarations.promptSections.map((section) => section.name));
  const presets: AgentPreset[] = declarations.presets.map((preset) => ({
    name: nativeScopedName(plugin, preset.name),
    label: preset.label,
    description: preset.description,
    promptSections: preset.promptSections.map((section) =>
      ownSections.has(section) ? nativeScopedName(plugin, section) : section,
    ),
    builtinTools: preset.builtinTools.map((tool) => ownTools.get(tool) ?? tool),
    defaultPermissionRules: preset.defaultPermissionRules.map((rule) => ({
      tool: ownTools.get(rule.tool) ?? rule.tool,
      decision: rule.decision,
      ...(rule.reason ? { reason: rule.reason } : {}),
    })),
  }));
  // Targets are kept as declared. A preset named here may belong to another
  // plugin, which can be installed later or removed at any time: the
  // composition treats a name that is not loaded as a no-op. Dropping it here
  // instead would leave the plugin without extensions, and its tools would
  // join every preset, the opposite of what it asked for.
  const presetExtensions: AgentPresetExtension[] = declarations.presetExtensions.flatMap(
    (extension): AgentPresetExtension[] => {
      const tools = extension.tools.map((tool) => ownTools.get(tool)!);
      if (tools.length === 0) return [];
      return "presets" in extension.target
        ? [{ target: { presets: [...extension.target.presets] }, tools }]
        : [{ target: { allExcept: [...extension.target.allExcept] }, tools }];
    },
  );
  return {
    id: input.moduleId,
    engine: {
      tools: declarations.tools.map((tool) => toolContribution(plugin, tool, calls)),
      ...(presets.length > 0 ? { presets } : {}),
      ...(presetExtensions.length > 0 ? { presetExtensions } : {}),
      promptSections: Object.fromEntries(
        declarations.promptSections.map((section) => [
          nativeScopedName(plugin, section.name),
          section.text,
        ]),
      ),
      dynamicContextProviders: declarations.context.map((context) =>
        contextProvider(plugin, context.name, calls),
      ),
      hooks: declarations.hooks.map((hook) => hookContribution(plugin, hook, calls)),
    },
  };
}
