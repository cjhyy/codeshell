/**
 * Test-only guard for rule 5 (utils/prompt-prefix-events.ts): every model
 * request of a session must extend the session's previous request unless a
 * registered rewrite happened in between. Opt in with one line per suite:
 *
 *   installPromptPrefixGuard({ beforeEach, afterEach });
 *
 * A test that sent an unregistered prefix change fails in afterEach with the
 * first diverging message of each violation.
 */
import {
  setPromptPrefixObserver,
  type PromptPrefixObserver,
  type PromptPrefixRewrite,
} from "../utils/prompt-prefix-events.js";
import type { Message } from "../types.js";

export interface PromptPrefixViolation {
  scope: string;
  /** Index of the first previous-request message the new request does not repeat. */
  index: number;
  previous: string;
  next: string | undefined;
}

/** Key-order independent JSON, so construction order of an object is not a "change". */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export class PromptPrefixGuard implements PromptPrefixObserver {
  readonly violations: PromptPrefixViolation[] = [];
  readonly rewrites: PromptPrefixRewrite[] = [];
  private readonly pendingRewrites = new Set<string>();
  private readonly last = new Map<string, string[]>();

  rewrite(scope: string, kind: PromptPrefixRewrite): void {
    this.pendingRewrites.add(scope);
    this.rewrites.push(kind);
  }

  messageLeft(scope: string, message: Message): void {
    const previous = this.last.get(scope);
    const index = previous?.lastIndexOf(canonical(message)) ?? -1;
    if (index !== -1) previous!.splice(index, 1);
  }

  request(scope: string, messages: readonly Message[]): void {
    // Keep content shapes exact. Providers differ in whether a text block and
    // a string serialize alike; the provider-neutral guard cannot assume that.
    const serialized = messages.map(canonical);
    const previous = this.last.get(scope);
    const rewritten = this.pendingRewrites.delete(scope);
    if (previous && !rewritten) {
      const index = previous.findIndex((message, i) => serialized[i] !== message);
      if (index !== -1) {
        this.violations.push({
          scope,
          index,
          previous: previous[index]!,
          next: serialized[index],
        });
      }
    }
    this.last.set(scope, serialized);
  }

  /** Forget a scope's previous request, e.g. after an intentional fresh start. */
  reset(scope?: string): void {
    if (scope === undefined) {
      this.last.clear();
      this.pendingRewrites.clear();
    } else {
      this.last.delete(scope);
      this.pendingRewrites.delete(scope);
    }
  }

  assertClean(): void {
    if (this.violations.length === 0) return;
    const clip = (text: string | undefined) =>
      text === undefined ? "(missing)" : text.length > 400 ? `${text.slice(0, 400)}…` : text;
    throw new Error(
      [
        `Unregistered prompt prefix change in ${this.violations.length} request(s):`,
        ...this.violations.map(
          (v) =>
            `- scope ${v.scope}, message ${v.index}\n  before: ${clip(v.previous)}\n  after:  ${clip(v.next)}`,
        ),
      ].join("\n"),
    );
  }
}

type Hook = (fn: () => void) => void;

/** Install a fresh guard around every test of the calling suite. */
export function installPromptPrefixGuard(hooks: { beforeEach: Hook; afterEach: Hook }): {
  readonly current: PromptPrefixGuard;
} {
  let guard = new PromptPrefixGuard();
  let previous: PromptPrefixObserver | undefined;
  hooks.beforeEach(() => {
    guard = new PromptPrefixGuard();
    previous = setPromptPrefixObserver(guard);
  });
  hooks.afterEach(() => {
    setPromptPrefixObserver(previous);
    previous = undefined;
    guard.assertClean();
  });
  return {
    get current() {
      return guard;
    },
  };
}
