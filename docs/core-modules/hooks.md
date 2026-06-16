# hooks

**One-line role.** The engine's lifecycle-hook pipeline: a priority-ordered registry that fans each lifecycle event out to user-, project-, plugin-, and code-registered handlers, runs user shell hooks as child processes, merges their `HookResult`s, and packages any returned messages into a single `<system-reminder>` for the model.

## 职责 / Responsibility

This module owns *how* lifecycle events (session/turn/tool/stop/permission/compact/notification) are dispatched to handlers and *how* their results are combined. It defines the event vocabulary (`HookEventName`), the handler contract (`HookHandler` / `HookContext` / `HookResult`), the chain-of-responsibility merge semantics (strictest-decision-wins for permission, append-for-context, last-write-wins for input/prompt rewrites), and the shell-out runner that turns a user's `settings.hooks` entry into a sandboxed child process speaking the Claude-Code shell-hook wire protocol. It does **not** decide *when* events fire (the Engine/TurnLoop/Executor emit them) nor *what* a handler should do — Goal mode's stop judge (`goal-stop-hook.ts`) lives here as the one bundled code handler, but most handlers come from settings, plugins, or SDK config.

## 文件 / Files

| File | Purpose |
| --- | --- |
| `registry.ts` | `HookRegistry` — register/unregister/emit handlers per event; priority-sorted chain execution and `HookResult` merge logic. The runtime heart of the module. |
| `events.ts` | Type definitions: `HookEventName` union (with extensive per-event emit docs), `HookContext`, `HookResult`. The source of truth for which events exist and what each field means. |
| `shell-runner.ts` | `runShellHook` / `shellHookMatches` — spawn a user-configured `settings.hooks` command as a child process, feed it the context envelope on stdin, parse stdout as a `HookResult`, with timeout/byte-cap/exit-code (0=ok, 2=deny) handling. |
| `hook-output.ts` | `MAX_HOOK_OUTPUT_BYTES` (1 MiB cap) and `validateHookResult` — shared output defences reused by both the shell runner and the plugin command runner so they can't diverge on what counts as valid. |
| `inject.ts` | `wrapHookMessages` — collapse handler-returned message strings into one user-role `<system-reminder>` Message; returns `null` if nothing to inject. |
| `goal-stop-hook.ts` | `createGoalStopHook` — the bundled `on_stop` handler that asks the model "is the goal met?" and blocks termination (`continueSession: true`) until it is. |
| `decision-merge.test.ts` | Unit test pinning the strictest-decision merge contract in `registry.ts`. |

## 公开接口 / Public API

Re-exported from the package root (`packages/core/src/index.ts`):

```ts
// registry.ts
export type HookHandler = (ctx: HookContext) => HookResult | Promise<HookResult>;

export class HookRegistry {
  register(eventName: HookEventName, handler: HookHandler, priority?: number, name?: string): void;
  unregister(eventName: HookEventName, handler: HookHandler): void;       // by handler identity
  emit(eventName: HookEventName, data?: Record<string, unknown>): Promise<HookResult>;
  hasHooks(eventName: HookEventName): boolean;
  clear(eventName?: HookEventName): void;                                  // clear one event or all
  listHooks(): Map<HookEventName, string[]>;
  listEvents(): HookEventName[];
  countHandlers(eventName: HookEventName): number;
}

// events.ts
export type HookEventName =
  | "on_agent_start" | "on_agent_end"
  | "on_turn_start"  | "on_turn_end"
  | "on_stop"
  | "on_tool_start"  | "on_tool_end"
  | "on_permission_check"
  | "on_session_start" | "on_session_end"
  | "pre_tool_use"   | "post_tool_use"
  | "user_prompt_submit"
  | "pre_compact"    | "post_compact"     // pre_compact reserved, not yet emitted
  | "file_changed"
  | "notification";

export interface HookContext { eventName: HookEventName; data: Record<string, unknown>; sessionId?: string; turnNumber?: number; }

export interface HookResult {
  stop?: boolean;                          // short-circuit the hook CHAIN (not agent termination)
  continueSession?: boolean;               // on_stop only: BLOCK agent termination, inject messages, run another turn
  data?: Record<string, unknown>;          // merged into ctx.data for downstream handlers + aggregated
  messages?: string[];                     // injected (via wrapHookMessages) as <system-reminder>
  decision?: "allow" | "deny" | "ask";     // permission override; strictest across chain wins
  updatedInput?: Record<string, unknown>;  // pre_tool_use: rewrite tool args (last handler wins, re-validated)
  additionalContext?: string;              // post_tool_use: append to tool output (handlers joined with blank line)
  updatedPrompt?: string;                  // user_prompt_submit: rewrite the latest user message (last wins)
}

// inject.ts
export function wrapHookMessages(messages: string[] | undefined): Message | null;
```

Not re-exported from the root but used internally across `core` (import from the submodule):

```ts
// shell-runner.ts
export function runShellHook(config: SettingsHookConfig, ctx: HookContext): Promise<HookResult>;
export function shellHookMatches(config: SettingsHookConfig, ctx: HookContext): boolean;

// hook-output.ts
export const MAX_HOOK_OUTPUT_BYTES: number;
export function validateHookResult(parsed: unknown): HookResult | null;

// goal-stop-hook.ts
export function createGoalStopHook(opts: GoalStopHookOptions): HookHandler;
```

## 怎么用 / How to use

### 1. Concatenating user + settings + plugin hooks onto one registry (Engine constructor)

The Engine layers all hook sources onto a single `HookRegistry` at construction, using **priority** to fix the chain order `plugin (80) → settings shell (50) → SDK code (default 0)`. Lower-priority (later-running) handlers can post-process or `stop` an earlier handler's contribution, but cannot relax its `deny` (see Gotchas).

```ts
// from engine/engine.ts (paraphrased)
this.hooks = new HookRegistry();

// (a) installed-plugin hooks from each plugin's hooks/hooks.json — priority 80
if (config.isSubAgent !== true) {
  const { disabledPlugins, disabledPluginHooks } = this.readDisabledLists();
  loadPluginHooks(this.hooks, disabledPlugins, disabledPluginHooks);
}

// (b) settings.hooks → wrap each entry as a shell-out handler — priority 50
for (const entry of settings.hooks ?? []) {
  if (entry.disabled === true) continue;                 // soft off-switch, hot via reloadHooks()
  const handler: HookHandler = async (ctx) =>
    shellHookMatches(entry, ctx) ? runShellHook(entry, ctx) : {};
  this.hooks.register(entry.event as HookEventName, handler, 50,
    `shell:${entry.event}:${entry.command.slice(0, 32)}`);
}

// (c) SDK/host-supplied code hooks — default priority 0
for (const hook of config.hooks ?? []) {
  this.hooks.register(hook.event, hook.handler, hook.priority, hook.name);
}
```

### 2. Emitting an event and injecting the merged messages (TurnLoop)

```ts
// from engine/turn-loop.ts (paraphrased)
const turnStartHook = await this.hooks.emit("on_turn_start", { turnNumber, isSubAgent });
const injection = wrapHookMessages(turnStartHook.messages);
if (injection) messages.push(injection);   // single <system-reminder> before the model call
```

### 3. Registering and tearing down a run-scoped handler (Goal mode)

`createGoalStopHook` returns a `HookHandler` registered on `on_stop` for the duration of one run, then `unregister`ed by identity so it never leaks across subsequent runs on the long-lived registry.

```ts
// from engine/engine.ts (paraphrased)
const goalHookHandler = createGoalStopHook({ llm, log, goal, onMet: () => this.clearActiveGoal() });
this.hooks.register("on_stop", goalHookHandler, 0, "goal-stop");
try {
  // ...run the turn loop; on_stop fires here and may block termination...
} finally {
  this.hooks.unregister("on_stop", goalHookHandler);   // identity-based removal
}
```

## 注意 / Gotchas

- **`emit` never throws.** Each handler runs inside a try/catch; a thrown handler is logged (`console.error`) and treated as a no-op so a buggy hook can't wedge the turn loop. Design handlers to fail loud-but-safe.
- **Decision merge is strictest-wins, not last-wins.** Across a chain, `deny > ask > allow`; a lower-priority handler can never relax a higher-priority handler's `deny`. This intentionally mirrors the executor's `clampHookDecision` "downgrades only" rule. (`data`, `updatedInput`, `updatedPrompt` *are* last-write-wins; `additionalContext` and `messages` are appended.)
- **`result.stop` vs `continueSession` are unrelated.** `stop` short-circuits the *hook chain* (no more handlers for this event). `continueSession` (honored only on `on_stop`) blocks *agent termination* and runs another turn. Confusing the two is an easy bug.
- **Shell hooks never crash the engine.** `runShellHook` swallows every failure mode — spawn error, timeout (60 s default, SIGTERM→SIGKILL), oversized stdout (>1 MiB → child killed), malformed/invalid JSON — and resolves `{}`. Only exit code `2` produces an effect on failure: `{ decision: "deny", messages: [stderr] }`. Non-2 non-zero exits are logged and dropped.
- **Sub-agents skip plugin and settings hooks.** When `config.isSubAgent === true`, neither `loadPluginHooks` nor `registerSettingsHooks` runs — only SDK code hooks and the goal hook apply. Don't rely on shell/plugin hooks firing inside dispatched tasks.
- **Settings-hook reload is identity-surgical.** `reloadHooks()` removes only the previously-tracked settings handlers (by identity) and re-registers from fresh disk settings — plugin/goal/code hooks are untouched. Toggling `entry.disabled` is therefore hot for new turns. Adding a brand-new builtin/event still needs the emitter wired first.
- **Reserved events don't fire.** `pre_compact` is defined in the union so downstream can pre-register, but nothing emits it yet (use `post_compact`). `on_agent_start`/`on_agent_end` are notify-only — their returned messages are **not** consumed; use `on_session_start` to inject.
- **Handlers must not wrap their own `<system-reminder>`.** The emit site owns the wrapper via `wrapHookMessages`; just return raw markdown strings in `messages`. Empty/whitespace-only messages are dropped.
- **`validateHookResult` rejects unknown top-level keys.** A typo'd field (or hostile payload) from a shell/plugin hook returns `null` (dropped), not a partial result — keep handler output strictly within the `HookResult` shape.
- **Goal-stop fails *closed*.** If the judge LLM throws or returns unparseable output, the hook returns `continueSession: true` (keep going), not allow-stop — silently letting an unattended goal fail is worse. The real infinite-loop backstop is the turn-loop's `maxStopBlocks` + run budget, not this hook. It also short-circuits (allows stop) when a background job is still running for the session.
- **Editing `core` requires a rebuild for dist consumers.** Hosts (TUI/desktop) import from `dist`; changes here need `bun run build` in `packages/core` before they take effect downstream.
