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
import { createHash } from "node:crypto";

/** Sessions whose user-context head a guard remembers; the oldest is forgotten first. */
const MAX_REMEMBERED_HEADS = 256;

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

/**
 * The message as the route puts it on the wire, as far as the guard can
 * tell. A finished reply is a string in the live history and one text block
 * when replayed from disk; the two are the same request only on a route that
 * sends both as the same bytes (LLMClientBase.sendsLoneTextBlockAsString).
 * Anywhere else the difference is a real prefix change.
 */
function wireForm(message: Message, loneTextBlockIsString: boolean): unknown {
  const block = Array.isArray(message.content) ? message.content[0] : undefined;
  if (
    loneTextBlockIsString &&
    message.role === "assistant" &&
    message.content.length === 1 &&
    block?.type === "text" &&
    // A plain non-empty text block only: an empty one or one carrying more
    // (reasoning) is sent differently from a string.
    !!block.text &&
    Object.keys(block).every((key) => key === "type" || key === "text")
  ) {
    return { ...message, content: block.text };
  }
  return message;
}

export class PromptPrefixGuard implements PromptPrefixObserver {
  readonly violations: PromptPrefixViolation[] = [];
  readonly rewrites: PromptPrefixRewrite[] = [];
  /** Rewrites that named no session; each excuses every session. */
  private sharedEpoch = 0;
  /** Rewrites per session: each excuses only that session's next request. */
  private readonly scopeEpochs = new Map<string, number>();
  private readonly last = new Map<string, { messages: string[]; epoch: string }>();
  /** Digest of each scope's latest user-context head. */
  private readonly heads = new Map<string, string>();

  rewrite(kind: PromptPrefixRewrite, scope: string | undefined): void {
    if (scope === undefined) this.sharedEpoch += 1;
    else this.scopeEpochs.set(scope, (this.scopeEpochs.get(scope) ?? 0) + 1);
    this.rewrites.push(kind);
  }

  private epoch(scope: string): string {
    return `${this.sharedEpoch}:${this.scopeEpochs.get(scope) ?? 0}`;
  }

  userContextHead(scope: string, head: string): void {
    const digest = createHash("sha256").update(head).digest("hex");
    const previous = this.heads.get(scope);
    if (previous !== undefined && previous !== digest) this.rewrite("user_context_head", scope);
    this.heads.delete(scope);
    this.heads.set(scope, digest);
    if (this.heads.size > MAX_REMEMBERED_HEADS) {
      this.heads.delete(this.heads.keys().next().value!);
    }
  }

  messageLeft(message: Message, scope: string | undefined): void {
    // Runtime context is user-authored text, never an assistant reply.
    const left = canonical(wireForm(message, false));
    const affected =
      scope === undefined ? [...this.last.values()] : [this.last.get(scope)].filter(Boolean);
    for (const previous of affected as Array<{ messages: string[] }>) {
      const index = previous.messages.lastIndexOf(left);
      if (index !== -1) previous.messages.splice(index, 1);
    }
  }

  request(scope: string, messages: readonly Message[], loneTextBlockIsString = false): void {
    const serialized = messages.map((message) =>
      canonical(wireForm(message, loneTextBlockIsString)),
    );
    const previous = this.last.get(scope);
    const epoch = this.epoch(scope);
    if (previous && previous.epoch === epoch) {
      const index = previous.messages.findIndex((message, i) => serialized[i] !== message);
      if (index !== -1) {
        this.violations.push({
          scope,
          index,
          previous: previous.messages[index]!,
          next: serialized[index],
        });
      }
    }
    this.last.set(scope, { messages: serialized, epoch });
  }

  /** Forget a scope's previous request, e.g. after an intentional fresh start. */
  reset(scope?: string): void {
    if (scope === undefined) this.last.clear();
    else this.last.delete(scope);
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
