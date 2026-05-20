/**
 * Built-in hook handler registration.
 *
 * Single entry point for the engine to wire up internal handlers that
 * ship with codeshell (currently: superpowers injector). Keep this module
 * the *only* place that decides which built-ins are on by default —
 * downstream code reads from preset / ENV via the resolver below and
 * never reaches into individual handler modules.
 */

import type { HookRegistry } from "../registry.js";
import type { HookContext, HookResult } from "../events.js";
import { createSuperpowersInjector } from "./superpowers-injector.js";

export interface BuiltinHookOptions {
  cwd: string;
  /**
   * From preset.strictSkills (engine reads preset.strictSkills ?? false).
   * Engine should pass `preset.strictSkills === true` so undefined/false
   * presets opt out by default — the explicit `=== true` keeps custom
   * presets safely off unless they declared the field.
   */
  strictSkills: boolean;
}

/**
 * ENV override for strictSkills, re-evaluated on every emit.
 *
 * `CODESHELL_STRICT_SKILLS=0` forces the superpowers injector off
 * regardless of preset; any other value (or unset) defers to the
 * preset. Read at handler-invocation time (not registration time) so
 * long-lived SDK consumers can toggle the env var between runs without
 * rebuilding the Engine.
 */
function isStrictSkillsDisabledByEnv(): boolean {
  return process.env.CODESHELL_STRICT_SKILLS === "0";
}

/**
 * Register codeshell's built-in hook handlers on `hooks` according to
 * `opts`. Call once per Engine after `new HookRegistry()` and before any
 * external `config.hooks` are registered, so user handlers can still
 * `stop` or post-process built-in injections via priority ordering.
 *
 * Handlers are registered when `opts.strictSkills` is true regardless of
 * the current ENV — the ENV check happens on each emit. This makes the
 * override observable to anyone who flips it mid-process (e.g. via
 * `process.env.X = "0"` in a test or REPL session).
 */
export function registerBuiltinHooks(
  hooks: HookRegistry,
  opts: BuiltinHookOptions,
): void {
  if (opts.strictSkills !== true) return;

  const injector = createSuperpowersInjector({ cwd: opts.cwd });

  const gatedSessionStart = (ctx: HookContext): HookResult => {
    if (isStrictSkillsDisabledByEnv()) return {};
    return injector.onSessionStart(ctx) as HookResult;
  };
  const gatedPromptSubmit = (ctx: HookContext): HookResult => {
    if (isStrictSkillsDisabledByEnv()) return {};
    return injector.userPromptSubmit(ctx) as HookResult;
  };

  hooks.register(
    "on_session_start",
    gatedSessionStart,
    // Run before any user-registered handlers so the meta-skill text
    // lands first in the aggregated <system-reminder>.
    100,
    "builtin:superpowers:on_session_start",
  );
  hooks.register(
    "user_prompt_submit",
    gatedPromptSubmit,
    100,
    "builtin:superpowers:user_prompt_submit",
  );
}
