/**
 * Shared output-handling primitives for hook runners.
 *
 * Two runners spawn child processes that produce HookResult JSON:
 *   - hooks/shell-runner.ts (user-configured shell hooks from settings)
 *   - plugins/pluginCommandHook.ts (hooks declared by installed plugins)
 *
 * Both need the same defences against:
 *   1. Runaway output (a chatty / malicious handler eating engine RAM).
 *   2. Schema drift (unknown decision values, typo'd top-level keys,
 *      non-string messages — silent no-ops are worse than rejections).
 *
 * Keeping the byte cap and validator in one module guarantees the two
 * runners can't accidentally diverge on what counts as "valid".
 */

import type { HookResult } from "./events.js";

/**
 * Cap hook output to avoid runaway logging / OOM. 1 MiB is more than enough
 * for any legitimate HookResult (which is typically < 1 KiB), while still
 * absorbing chatty handlers without truncating their decision/messages
 * payload. Past the cap callers kill the child and treat the hook as failed.
 */
export const MAX_HOOK_OUTPUT_BYTES = 1024 * 1024;

/**
 * Permissive runtime check that a parsed object matches HookResult.
 * Rejects unknown decision values, non-string/array fields, and unknown
 * top-level keys (signalling a typo or hostile/garbage payload). Returns
 * a normalized HookResult on success or null on failure — caller treats
 * null the same as "no result, drop it".
 *
 * Exported so a unit test can pin the contract without spawning a shell.
 */
export function validateHookResult(parsed: unknown): HookResult | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  const known = new Set([
    "stop",
    "data",
    "messages",
    "decision",
    "updatedInput",
    "additionalContext",
    "updatedPrompt",
  ]);
  for (const k of Object.keys(p)) {
    if (!known.has(k)) return null;
  }
  if ("stop" in p && typeof p.stop !== "boolean") return null;
  if ("data" in p) {
    if (!p.data || typeof p.data !== "object" || Array.isArray(p.data)) return null;
  }
  if ("messages" in p) {
    if (!Array.isArray(p.messages)) return null;
    for (const m of p.messages) {
      if (typeof m !== "string") return null;
    }
  }
  if ("decision" in p) {
    if (p.decision !== "allow" && p.decision !== "deny" && p.decision !== "ask") return null;
  }
  if ("updatedInput" in p) {
    if (!p.updatedInput || typeof p.updatedInput !== "object" || Array.isArray(p.updatedInput))
      return null;
  }
  if ("additionalContext" in p && typeof p.additionalContext !== "string") return null;
  if ("updatedPrompt" in p && typeof p.updatedPrompt !== "string") return null;
  return p as HookResult;
}
