/**
 * Built-in superpowers injector.
 *
 * Bridges the Claude-Code parity gap: CC ships a SessionStart hook that
 * injects the `using-superpowers` SKILL.md body (1% rule, Red Flags,
 * skill-flow DOT diagram) as a <system-reminder>, forcing the model to
 * consult skills before acting. Without that injection, codeshell's
 * model-side trigger discipline collapses to "list of skills exists,
 * model maybe checks them" — which is the bug surfaced in
 * `reference_cc_architecture` discussion.
 *
 * Wiring:
 *   - on_session_start: inject the full SKILL.md body once per Engine.run()
 *     so the model sees the ruleset (Red Flags table + DOT flow + 1% rule).
 *   - user_prompt_submit: inject a short one-line nudge on every user turn
 *     so the discipline doesn't drift mid-session (matches CC's per-turn
 *     UserPromptSubmit reminders).
 *
 * Both handlers no-op when ctx.data.isSubAgent === true. Subagents get a
 * focused task and shouldn't waste tokens re-reading the meta-skill —
 * SKILL.md itself contains a <SUBAGENT-STOP> block but we short-circuit
 * before the model ever sees the text, so subagent token budgets stay tight.
 */

import type { HookContext, HookResult } from "../events.js";
import type { HookHandler } from "../registry.js";
import { scanSkills } from "../../skills/scanner.js";

const SUPERPOWERS_SKILL_NAME = "superpowers:using-superpowers";

const PER_TURN_REMINDER =
  "Skills are available for this conversation. Before any non-trivial action " +
  "(including clarifying questions), invoke the `Skill` tool to check if a " +
  "skill applies. Refer to the using-superpowers ruleset for trigger discipline.";

export interface SuperpowersInjectorOptions {
  cwd: string;
}

interface SuperpowersInjectorBundle {
  onSessionStart: HookHandler;
  userPromptSubmit: HookHandler;
}

/**
 * Build the two hook handlers needed to bring skill discipline in line
 * with Claude Code. Caller is responsible for registering them on the
 * appropriate events (see registerBuiltinHooks).
 *
 * No injector-level caching: scanSkills itself memoizes by
 * `cwd \0 HOME \0 installedPlugins.mtimeMs`, so plugin installs/removals
 * naturally invalidate and the per-emit overhead is one Array.find over
 * ~30 entries. Adding a second layer of caching here would only hide
 * scanner invalidations and complicate testing.
 *
 * If the meta-skill is missing on disk, we log a one-shot console.warn
 * pointing the user at the plugin command — otherwise strictSkills=true
 * would silently degrade to a no-op and the user would never know why
 * the model isn't following skill discipline.
 */
export function createSuperpowersInjector(
  options: SuperpowersInjectorOptions,
): SuperpowersInjectorBundle {
  let warnedMissing = false;

  const loadBody = (): string | null => {
    const skills = scanSkills(options.cwd);
    const found = skills.find((s) => s.name === SUPERPOWERS_SKILL_NAME);
    if (!found) {
      if (!warnedMissing) {
        warnedMissing = true;
        // eslint-disable-next-line no-console
        console.warn(
          "[hooks] strictSkills is enabled but `superpowers:using-superpowers` " +
            "is not installed. Install with: code-shell plugin install superpowers@superpowers",
        );
      }
      return null;
    }
    return found.content;
  };

  const onSessionStart: HookHandler = (ctx: HookContext): HookResult => {
    if (ctx.data.isSubAgent === true) return {};
    const body = loadBody();
    if (!body) return {};
    return { messages: [body] };
  };

  const userPromptSubmit: HookHandler = (ctx: HookContext): HookResult => {
    if (ctx.data.isSubAgent === true) return {};
    // Only emit the reminder if the meta-skill exists on disk; otherwise
    // the on_session_start payload would also be empty and the per-turn
    // nudge would be a dangling reference to nothing.
    if (loadBody() === null) return {};
    return { messages: [PER_TURN_REMINDER] };
  };

  return { onSessionStart, userPromptSubmit };
}
