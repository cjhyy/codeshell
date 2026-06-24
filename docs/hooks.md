# Hooks

codeshell ships a lifecycle hook system modeled on Claude Code's. Hooks let
you observe and modify the engine's behavior at well-defined points
without forking the codebase.

## Two ways to register

**1. SDK / code-level** (in-process):

```ts
import { Engine } from "@cjhyy/code-shell";

const engine = new Engine({
  llm: { provider: "openai", model: "gpt-4o", apiKey: "..." },
  hooks: [
    {
      event: "pre_tool_use",
      handler: async (ctx) => {
        if (ctx.data.toolName === "Bash") {
          const cmd = (ctx.data.args as { command: string }).command;
          if (cmd.includes("rm -rf /")) {
            return { decision: "deny", messages: ["catastrophic command blocked"] };
          }
        }
        return {};
      },
      priority: 100,
      name: "rm-rf-guard",
    },
  ],
});
```

**2. settings.json** (shell command, no code):

```jsonc
// ~/.code-shell/settings.json (or <project>/.code-shell/settings.json)
{
  "hooks": [
    {
      "event": "pre_tool_use",
      "matcher": "Edit|Write",
      "command": "scripts/lint-check.sh",
      "timeout_ms": 30000
    },
    {
      "event": "notification",
      "command": "osascript -e 'display notification \"sub-agent done\"'"
    }
  ]
}
```

Shell hooks receive the full `HookContext` envelope on stdin as JSON and
return a `HookResult` on stdout. See "Shell protocol" below for the wire
contract.

**Trust boundary:** settings shell hooks and plugin command hooks execute host
shell commands. They do not pass through the `Bash` tool permission flow and
are not covered by the Bash sandbox backend. Installing or enabling a plugin
with lifecycle hooks is therefore equivalent to trusting that plugin to run
commands on the host.

## Available events

| Event | Fires from | Notable ctx.data | Common uses |
| --- | --- | --- | --- |
| `on_session_start` | `Engine.run()` entry, once per run | `sessionId`, `cwd`, `resumed`, `isSubAgent` | Inject session-wide reminders. Built-in superpowers injector uses this. |
| `on_session_end` | `Engine.run()` exit | `sessionId`, `reason`, `turnCount` | Audit logging, end-of-session metrics. Returned messages are dropped. |
| `user_prompt_submit` | Each new user prompt enters the loop | `sessionId`, `prompt`, `resumed`, `isSubAgent` | Rewrite the user's prompt (`updatedPrompt`), inject per-turn reminders, mask secrets. |
| `on_agent_start` / `on_agent_end` | Before/after the turn loop | `sessionId`, `task` / `reason`, `turnCount` | Telemetry. Returned messages are NOT consumed — use `on_session_start` instead. |
| `on_turn_start` / `on_turn_end` | Each LLM call boundary inside the loop | `turnNumber`, `hasToolUse`, `toolCallCount` | Inject per-turn reminders. |
| `pre_tool_use` | Before every tool call | `toolName`, `args`, `toolCallId` | Approve/deny/ask, rewrite args (`updatedInput`). |
| `post_tool_use` | After every tool call | `toolName`, `toolCallId`, `result`, `error` | Append text to result (`additionalContext`); linter/typecheck hooks. |
| `on_tool_start` / `on_tool_end` | Wraps tool execution itself | Same as pre/post | Pure observability — fires inside permission-approved zone only. |
| `on_permission_check` | After classifier runs, before deciding | `toolName`, `args`, `classifierDecision` | Override the rule set's verdict via `decision`. |
| `file_changed` | After successful Write/Edit | `toolName`, `filePath` | Trigger re-formatters, auto-tests. |
| `post_compact` | After non-micro context compaction | `strategy`, `beforeTokens`, `afterTokens` | Remind the model "context was just compacted — re-check recent decisions". |
| `on_stop` | Model returns no tool calls, loop about to return reason "completed" | `goal`, `finalText`, `turnCount` | Goal mode seam: a handler returning `continueSession: true` (with `messages`) BLOCKS termination — messages injected as `<system-reminder>` and the loop runs another turn. Bounded by `maxStopBlocks` + `maxTurns`. Distinct from `HookResult.stop` (which controls the hook chain). See `goal-stop-hook.ts`. |
| `notification` | Background sub-agent terminates | `kind` (agent_completed/agent_failed/agent_cancelled), `agentId`, `name`, `description`, plus `finalText` or `error` | Desktop notifications. Fire-and-forget — handler latency does not block the engine. |

All Engine-side emits also carry `isSubAgent` in `ctx.data` so handlers can
skip noisy injections for spawned children:

```ts
handler: (ctx) => {
  if (ctx.data.isSubAgent === true) return {};
  return { messages: ["only for the parent agent"] };
}
```

## HookResult fields

```ts
interface HookResult {
  /** Stop the chain after this handler. Remaining handlers don't fire. */
  stop?: boolean;

  /** Merged into ctx.data for downstream handlers in the same emit. */
  data?: Record<string, unknown>;

  /** Markdown strings packed into a single user-role <system-reminder>
   *  before the next LLM call. Multiple handlers' messages are joined. */
  messages?: string[];

  /** For pre_tool_use / on_permission_check: deny | allow | ask.
   *  - deny short-circuits the tool with an error
   *  - allow skips the permission classifier entirely
   *  - ask routes through ApprovalBackend with handler's messages as reason */
  decision?: "allow" | "deny" | "ask";

  /** For pre_tool_use: replace the tool's args (re-validated against schema). */
  updatedInput?: Record<string, unknown>;

  /** For post_tool_use: text appended to the tool's content with a separator. */
  additionalContext?: string;

  /** For user_prompt_submit: replace the user's prompt text. Empty string allowed. */
  updatedPrompt?: string;
}
```

### Aggregation rules

When multiple handlers fire for the same event, the registry aggregates them:

| Field | Rule |
| --- | --- |
| `messages` | concatenated in priority order |
| `additionalContext` | joined with `\n\n` separators |
| `decision` | **strictest-wins** (`deny` > `ask` > `allow`; a later handler cannot relax an earlier `deny`). See `DECISION_RANK` / `stricterDecision` in `hooks/registry.ts`. |
| `updatedInput`, `updatedPrompt` | **last-write-wins** (lowest-priority handler that returns a value owns the override) |
| `data` | shallow-merged forward; later handlers see earlier handlers' edits |
| `stop` | aborts the chain immediately, prior aggregates preserved |

Because `decision` is strictest-wins, a `deny` from any handler cannot be relaxed
by a lower-priority handler later in the chain. Use `stop: true` only when you
want to halt the hook chain immediately (before remaining handlers run) — it is
not needed to make a `deny` stick.

## Shell protocol

When you configure a hook in `settings.json`, codeshell spawns the command
as a child process on every emit. The wire protocol matches CC's:

### stdin

The full `HookContext`, JSON-encoded:

```json
{
  "eventName": "pre_tool_use",
  "data": {
    "toolName": "Edit",
    "args": { "file_path": "/repo/src/foo.ts", "..." : "..." },
    "toolCallId": "call_abc",
    "isSubAgent": false
  }
}
```

### stdout

Either empty (no-op) or a JSON `HookResult`:

```json
{
  "messages": ["lint passed for foo.ts"],
  "additionalContext": "0 warnings"
}
```

Unparseable stdout on exit 0 is logged at warn level and dropped — a buggy
script never wedges the loop.

### exit codes

| Code | Meaning |
| --- | --- |
| 0 | Normal. Stdout (if any) is parsed as HookResult. |
| 2 | Deny. Stderr becomes the rejection reason and is surfaced to the model via `HookResult.messages`. |
| other | Handler error. Stderr is logged; behaves as `{}` (no effect). |

### environment

| Var | Value |
| --- | --- |
| `CODESHELL_HOOK_EVENT` | The event name (same as `eventName` on stdin). |
| `CODESHELL_HOOK_CWD` | `settings.cwd` if set, else the Engine's cwd. |

### timeout

Default: 60 seconds. Override per-entry with `timeout_ms`. On timeout the
child receives SIGTERM then SIGKILL after a 1s grace period, and the
handler resolves to `{}`.

### matcher

For tool events (`pre_tool_use`, `post_tool_use`, `on_tool_start`,
`on_tool_end`, `on_permission_check`, `file_changed`), you can filter
which tools fire the hook via a regex on the tool name:

```json
{ "event": "pre_tool_use", "matcher": "Edit|Write|Bash", "command": "..." }
```

For non-tool events (session/turn/prompt/compact/notification), `matcher`
makes no sense and the hook is silently skipped if you set one.

## Priority order

Within a single event, handlers fire from highest to lowest priority:

```
priority 100 — built-in (e.g. superpowers injector)
priority  80 — installed plugin hooks
priority  50 — settings.json shell hooks
priority   0 — SDK config.hooks
```

You can override by passing `priority` in the SDK config or by stacking
hooks with explicit priorities. Use `stop: true` from a handler to halt
the chain.

## Toggle / kill-switch

The superpowers injector is contributed by the **superpowers plugin's
`SessionStart` hook** (it ships pre-installed), surfaced via the
`on_session_start` hook in `Engine.run()`. Turn it off through the standard
plugin/skill disable lists in `settings.json` (global baseline + per-project
overlay) — there is no dedicated `strictSkills` field or env var:

| Surface | Behavior |
| --- | --- |
| `settings.disabledPlugins: ["superpowers"]` | Coarse total switch: a disabled plugin contributes **no** hooks, so its `SessionStart` injection is suppressed too — not just its Skill-tool entries (`packages/core/src/plugins/loadPluginHooks.ts`). |
| `settings.disabledPluginHooks` | Fine-grained per-hook switch: suppress just the injection hook while keeping the plugin's skills usable. |
| `settings.disabledSkills` | Hides individual skills from the Skill tool without disabling the whole plugin. |

Shell hooks are unconditionally on whenever `settings.hooks` is present —
edit `settings.json` to disable. Sub-agents skip shell hooks entirely
(performance — spawning per emit per sub-agent multiplies overhead).

## Differences from Claude Code

| Aspect | CC | codeshell |
| --- | --- | --- |
| Stop | Yes (custom event on assistant Stop) | Use `on_turn_end` / `on_session_end` |
| SubagentStop | Yes | Use `notification` (kind: `agent_completed`) |
| `pre_compact` | Yes | **Not emitted yet** — current implementation only knows after the fact; use `post_compact`. |
| Hook output protocol | JSON + exit 2 | Same |
| `additionalContext` for `UserPromptSubmit` | Yes | Use `messages` (always wrapped in a `<system-reminder>`) |
| Shell hooks share `permissionDecision` block | Yes | Same (via `decision`) |
| Event names | CamelCase (`PreToolUse`) | snake_case (`pre_tool_use`) |

If you're migrating CC hooks, mostly: rename event names to snake_case and
the rest carries over.
