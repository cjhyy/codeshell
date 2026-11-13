/**
 * Rule 5 of docs/todo/prompt-cache-optimization.md §五: every break of a
 * session's request prefix must be attributable. Production code reports the
 * retroactive rewrites it applies and the model requests it sends; the
 * test-only guard (testing/prompt-prefix-guard.ts) checks that consecutive
 * requests of a session extend each other unless a rewrite was reported in
 * between.
 *
 * Nothing happens unless a guard is installed: each report is one property
 * read on `globalThis` and no allocation. The observer lives on `globalThis`
 * (not in this module) so source and built copies of core share it.
 */
import type { Message } from "../types.js";

/** Retroactive rewrites that legitimately change an already-sent prefix. */
export type PromptPrefixRewrite =
  /** Batched dedupe/mask/microcompact/image placeholders (context/rewrite-gate.ts). */
  | "rewrite_batch"
  /** Image placeholders forced by the hard count/byte caps (context/image-history-window.ts). */
  | "image_batch"
  /** summary / snip / window / emergency / range compaction, notes rollover. */
  | "compaction"
  /** Turn-range archive or pre-run archive marker. */
  | "archive"
  /** Instruction context cleared (revoked/changed bindings). */
  | "clear_context"
  /** The run's user-context head (instructions) differs from the previous run's. */
  | "user_context_head"
  /** The workspace changed: context told for the old one was revoked (run-context-ledger.ts). */
  | "workspace_root_changed"
  /** Context-limit recovery dropped the oldest rounds. */
  | "context_limit_recovery"
  /** A truncated reply continued: the trailing assistant text is re-sent longer. */
  | "max_tokens_continuation";

export interface PromptPrefixObserver {
  rewrite(scope: string, kind: PromptPrefixRewrite): void;
  /**
   * One message left its place in history: a run's non-durable runtime
   * context moved to the request tail or was removed after the run. Every
   * other message must still extend the previous request.
   */
  messageLeft(scope: string, message: Message): void;
  /** `scope` is the session; `messages` are exactly what the request carries. */
  request(scope: string, messages: readonly Message[]): void;
}

const OBSERVER = Symbol.for("codeshell.promptPrefixObserver");
type Holder = { [OBSERVER]?: PromptPrefixObserver };

export function notePromptPrefixRewrite(
  scope: string | undefined,
  kind: PromptPrefixRewrite,
): void {
  if (scope !== undefined) (globalThis as Holder)[OBSERVER]?.rewrite(scope, kind);
}

export function notePromptMessageLeft(scope: string | undefined, message: Message): void {
  if (scope !== undefined) (globalThis as Holder)[OBSERVER]?.messageLeft(scope, message);
}

export function notePromptRequest(scope: string, messages: readonly Message[]): void {
  (globalThis as Holder)[OBSERVER]?.request(scope, messages);
}

/** Install (or with `undefined`, remove) the observer; returns the previous one. */
export function setPromptPrefixObserver(
  observer: PromptPrefixObserver | undefined,
): PromptPrefixObserver | undefined {
  const holder = globalThis as Holder;
  const previous = holder[OBSERVER];
  if (observer) holder[OBSERVER] = observer;
  else delete holder[OBSERVER];
  return previous;
}

/** Cheap opt-in check before preparing diagnostic data such as instruction hashes. */
export function hasPromptPrefixObserver(): boolean {
  return (globalThis as Holder)[OBSERVER] !== undefined;
}
