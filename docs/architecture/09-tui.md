# 09 · TUI Package

> The terminal client: the `code-shell` CLI, an Ink-based REPL, and a hand-written terminal renderer. Source-mapped against `packages/tui/` (~42 K LOC). It is a thin client over the protocol layer — it does not run the `Engine` itself.

## 1. Shape of the package

| Area | Key files | ~LOC |
|------|-----------|------|
| CLI entry & subcommands | `cli/main.ts`, `cli/commands/{run,repl}.ts`, `bootstrap/setup.ts` | ~900 |
| REPL app state | `ui/App.tsx`, `ui/store.ts`, `ui/input-history.ts`, `ui/vim-mode.ts` | ~3,000 |
| Slash commands | `cli/commands/registry.ts`, `cli/commands/builtin/*` | ~2,000 |
| Custom renderer | `render/ink.tsx`, `render/render-node-to-output.ts`, `render/screen.ts`, `render/selection.ts`, … | ~14,000 |
| Native layout | `native-ts/yoga-layout/` (TS flexbox engine) | ~2,500 |
| Headless output | `cli/output/renderer.ts` | ~100 |

## 2. CLI entry & subcommands (`cli/main.ts`)

A Commander program with a `preAction` hook (`bootstrap/setup.ts`: Node ≥20.10, cwd validation, rejecting `bypassPermissions` as root, log rotation). Subcommands:
- **`run [task]`** — headless one-shot; streams to a format renderer (`text`/`json`/`jsonl`/`stream-json`).
- **`repl`** (default when no task) — interactive Ink UI.
- **`sessions`**, **`runs`**, **`arena`**, **`plugin`** — list/query/multi-model/registration.

Flags include `-m/--model`, `-p/--provider`, `--preset`, `--permission-mode`, `--effort`, `--resume`, `--prefill`. If no command and a `[task]` arg is present → `run`; otherwise → `repl`.

## 3. How the TUI talks to core: in-process protocol

The TUI builds an **in-process** transport (`createInProcessTransport`), wires an `AgentServer` (over a `ChatSessionManager`) on one end and an `AgentClient` on the other, and a seed `Engine` populates the shared `ModelPool` + `ToolRegistry` via an `EngineRuntime`. The UI never calls `Engine` — it does `client.run(task, sessionId)` and subscribes with `client.onStreamEvent(...)`. This is the same protocol seam ([04](04-protocol-and-sessions.md)) the desktop uses over stdio; here it's in-process for zero serialization and shared memory. Session state is server-owned; resuming just re-sends a `sessionId`.

## 4. The Ink REPL (`ui/App.tsx`, ~2,278 LOC)

`App.tsx` is the app state machine. The defining design choice: chat entries live in an **external store** (`ui/store.ts`) consumed via `useSyncExternalStore`, *not* React state — so appending a message doesn't re-render the whole tree. A `ChatEntry` union covers `user`, `assistant_text` (with `streaming` + `agentId`), `tool_start`/`tool_running`/`tool_result`, `thinking`, `agent_start`/`agent_end`, `error`, `status`, `system`.

**Stream handling** (`handleStreamEvent`): text/thinking deltas accumulate in a `textBufferRef` and flush on a **50 ms timer** — LLMs emit 30–200 tokens/s, so coalescing turns that into ~20 re-renders/s. `tool_use_start` flushes the buffer and adds a running entry; `tool_result` replaces it. `approval_request` and `ask_user` raise the permission/question prompts. Sub-agent text (`agentId` set) is routed to the `AgentDock` sidebar, kept out of the main feed.

**Input**: `CommandInput`/`TextInput` with slash-command autocomplete, vim-mode keybindings (`ui/vim-mode.ts`: normal/insert/visual/command), and persisted history (`ui/input-history.ts`). `Shift+Tab` cycles permission mode (plan → normal → bypass) for the next submit.

**Slash commands**: a `CommandRegistry` dispatches `SlashCommand`s grouped into ~12 registries; the largest is `core-commands.ts` (`/help`, `/model`, `/models`, `/resume`, `/goal`, `/fullscreen`, `/settings`, `/export`, …). A `CommandContext` hands each command the client, cwd, model setters, goal hooks, and UI openers. **In-REPL cron** is wired in `repl.ts` via `bindCronToEngine` against a read-only engine per fired job (see [06](06-long-running-orchestration.md)).

## 5. The custom renderer (`render/`)

CodeShell does **not** use stock Ink's incremental renderer (it flickers and drops updates). Instead `render/` is a hand-written, line-level diff renderer with a TypeScript port of Yoga for flexbox layout:

```
React tree → reconciler commit → DOM (ink-box/ink-text/...) →
Yoga.calculateLayout → render-node-to-output (screen buffer, viewport culling,
selection/search overlays) → ANSI diff → terminal (DEC 2026 synchronized output)
```

Major files: `render/ink.tsx` (the `Ink` class + reconciler), `render/screen.ts` (cell/style/char pools), `render/render-node-to-output.ts` (DOM→buffer + scroll hints), `render/log-update.ts` (hardware-scroll hints via DECSTBM), `render/selection.ts` (drag-select + OSC-52 clipboard), `render/parse-keypress.ts` (kitty/xterm/legacy decoding).

### Fullscreen vs flow
Fullscreen (alt-screen + `ScrollBox` + virtual scroll) is the **default** — it repaints cleanly on resize. Flow mode (`CODESHELL_FULLSCREEN=0` or `/fullscreen off`) lets the transcript flow into the terminal's native scrollback but can duplicate content after a resize (documented in the README). The toggle flushes committed entries to `<Static>` so older lines land in scrollback before exiting alt-screen.

### ScrollBox & scroll feel
`ScrollBox` exposes an imperative handle (`scrollTo`/`scrollBy`/`scrollToBottom`/`isSticky`) that mutates a pending-delta on the DOM node and schedules a throttled (60 fps) render rather than calling `setState` per event. Sticky-scroll auto-pins to the bottom as content grows. Per the user's stated preference, **one wheel-click = one row**, and copy-on-select must wire `copySelectionNoClear` on mouseup (the render-scroll-copy feedback note).

## 6. Headless output (`cli/output/renderer.ts`)

For `run`, an `OutputRenderer` (text / json / jsonl / stream-json) consumes the same `StreamEvent`s: text → stdout, tool/agent lifecycle → stderr status lines with sub-agent indentation, final result printed or JSON-serialized.

## 7. Invariants worth remembering
- **Thin client**: the UI sends messages to `AgentClient`; the Engine runs behind the protocol seam.
- **External store + 50 ms buffering**: keeps render rate bounded regardless of token rate.
- **Custom renderer over Ink incremental**: ~14 K LOC of `render/` exists to make terminal repaint correct and flicker-free.
- **Fullscreen default**: cleaner resize at the cost of native scrollback.

When verifying a TUI change, run the current build (`bun run dev:tui`) — the memory note on stale bundles warns that "clicked, nothing happened" is often an out-of-date build, not a source bug.

## 8. Where to read next
- The protocol the TUI rides: [04 · Protocol & sessions](04-protocol-and-sessions.md)
- The same renderer concepts, but in a browser DOM: [10 · Desktop & mobile](10-desktop-and-mobile.md)
- The engine behind `client.run`: [01 · Engine & turn loop](01-engine-and-turn-loop.md)
