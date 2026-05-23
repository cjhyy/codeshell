# Electron Codex UI Gap Analysis

> Date: 2026-05-24
> Scope: current `packages/desktop` Electron client vs. a Codex-style desktop coding agent experience.

## Summary

The current Electron app is a functional MVP for the agent loop. It already has:

- Electron main process as a broker to an agent worker subprocess.
- Preload bridge exposing a narrow `window.codeshell` API.
- React renderer with repo sidebar, chat stream, tool call blocks, approval modal, stop/cancel, and per-repo local transcript storage.

It is not yet a product-grade desktop UI. The largest missing pieces are not just visual polish, but information architecture:

- session browser
- top-level workspace shell
- run/task status surfaces
- tool-specific visualization
- diff and file-change review
- approval center
- settings/model/permission UI
- right-side inspector
- long-transcript performance

For UI work, the recommended first milestone is:

1. Build a Codex-style shell: sidebar, top bar, chat, inspector.
2. Replace placeholder sidebar items with real views and state.
3. Expand stream event handling so the renderer can show sessions, tasks, thinking, usage, sub-agents, and compaction.
4. Split generic tool JSON into tool-specific cards.
5. Add approval and diff review surfaces.

## Current Implementation Snapshot

### Main Process

Relevant files:

- `packages/desktop/src/main/index.ts`
- `packages/desktop/src/main/agent-bridge.ts`
- `packages/desktop/src/main/desktop-logger.ts`

Current behavior:

- Creates one `BrowserWindow`.
- Loads Vite dev URL or built renderer HTML.
- Opens DevTools automatically in dev.
- Exposes native folder picker via `dialog:pickDir`.
- Instantiates `AgentBridge`.
- Kills the worker on app quit.

Missing product pieces:

- Native application menu.
- Window title/subtitle updates based on active repo/session.
- Multi-window or new-session window flow.
- Recent projects menu.
- Global shortcuts.
- Desktop notifications.
- Packaged app behavior, signing, updates.
- Workspace trust and permission prompts before exposing sensitive repo actions.

### Agent Bridge

Relevant file:

- `packages/desktop/src/main/agent-bridge.ts`

Current behavior:

- Spawns `@cjhyy/code-shell-core/bin/agent-server-stdio` on `agent/run`.
- Uses Electron binary as Node runtime with `ELECTRON_RUN_AS_NODE=1`.
- Pipes renderer JSON-RPC lines to child stdin.
- Pipes child stdout lines back to renderer.
- Logs child stderr.
- Tracks crash loop and emits lifecycle events.

Missing product pieces:

- Long-lived app-server abstraction.
- Capability handshake between renderer and backend.
- Query APIs for sessions, runs, settings, models, logs, tools, and filesystem metadata.
- Robust restart/resume after worker crash.
- Worker status beyond simple lifecycle messages.
- Structured error categories for UI display.

### Preload Bridge

Relevant files:

- `packages/desktop/src/preload/index.ts`
- `packages/desktop/src/preload/types.d.ts`

Current exposed API:

- `run`
- `cancel`
- `approve`
- `onStreamEvent`
- `onApprovalRequest`
- `onStatus`
- `onAgentLifecycle`
- `pickDir`
- `log`

Missing APIs for Codex-style UI:

- `query` for read-only backend data.
- `configure` for plan mode, permission mode, model selection, sandbox, and feature flags.
- `listSessions`, `loadSession`, `newSession`, `renameSession`, `deleteSession`.
- `listRuns`, `getRun`, `resumeRun`, `cancelRun`.
- `getSettings`, `updateSettings`, `validateProviderKey`.
- `listModels`, `setActiveModel`.
- `listMcpServers`, `connectMcpServer`, `disconnectMcpServer`.
- `getGitStatus`, `getGitDiff`, `openExternal`, `revealInFinder`.
- `subscribeLogs` or `tailLog`.

## Renderer: Existing UI

Relevant files:

- `packages/desktop/src/renderer/App.tsx`
- `packages/desktop/src/renderer/Sidebar.tsx`
- `packages/desktop/src/renderer/ChatView.tsx`
- `packages/desktop/src/renderer/MessageStream.tsx`
- `packages/desktop/src/renderer/ToolCallBlock.tsx`
- `packages/desktop/src/renderer/ApprovalModal.tsx`
- `packages/desktop/src/renderer/types.ts`
- `packages/desktop/src/renderer/transcripts.ts`
- `packages/desktop/src/renderer/repos.ts`
- `packages/desktop/src/renderer/styles.css`

Current UI:

- Two-column layout: left sidebar and main chat.
- Sidebar has static nav labels: chat, search, plugins, automations.
- Repo list can add/remove/select directories.
- Welcome overlay for empty repo/chat.
- Chat input supports IME, prompt history, auto-grow, stop button.
- Assistant messages stream as plain text, then render markdown after completion.
- Tool calls render as collapsible JSON blocks.
- Approval uses a modal.
- Transcript is persisted in `localStorage` by repo id.

## Major Gaps

## 1. Product Shell And Layout

Current problem:

The app has only a simple two-column MVP layout. It lacks the desktop product shell that makes Codex feel like a workspace app rather than a chat page.

Required UI:

- Top bar with:
  - app name
  - active repo
  - active session title
  - current branch
  - current model
  - permission mode
  - context/token usage
  - running/idle indicator
- Left sidebar with:
  - workspaces/repos
  - session list
  - runs
  - approvals
  - models/settings/logs entry points
- Main chat area.
- Right inspector panel for selected message/tool/file/diff/run.
- Collapsible sidebars.
- Empty states for no repo, no session, no approvals, no runs.

Recommended first change:

- Wire `TopBar.tsx` into `App.tsx`.
- Change `app-grid` from two columns to three regions:
  - sidebar
  - main
  - inspector
- Add local `view` state for sidebar navigation.
- Add selected message/tool state for inspector.

## 2. Sidebar Navigation Is Placeholder

Current problem:

`Sidebar.tsx` renders menu items, but they do not switch views and do not represent real app state.

Current placeholder items:

- 对话
- 搜索
- 插件
- 自动化

Required behavior:

- Active nav state.
- Clickable routes or view modes.
- Badge counts:
  - pending approvals
  - running tasks
  - failed runs
  - background agents
- Sections:
  - Workspaces
  - Sessions
  - Runs
  - Approvals
  - Tools/MCP
  - Settings
- Repo rows should show:
  - repo name
  - path tooltip
  - git branch
  - dirty status
  - running session indicator
  - last activity time

Implementation notes:

- Replace emoji icons with an icon library, preferably `lucide-react`.
- Keep rows dense and scannable.
- Do not make the sidebar a marketing-style card layout.

## 3. Session Browser

Current problem:

The renderer stores one transcript bucket per repo in `localStorage`. This is not a real session system.

Current files:

- `packages/desktop/src/renderer/transcripts.ts`
- `packages/desktop/src/renderer/repos.ts`

Missing behavior:

- Create new session.
- Resume previous session.
- Rename session.
- Delete session.
- Search sessions.
- Show session title generated from first user prompt.
- Show session metadata:
  - session id
  - repo
  - cwd
  - model
  - created time
  - updated time
  - status
  - token usage
  - cost
- Distinguish UI transcript from engine transcript.
- Handle `session_started` stream event and bind UI state to authoritative engine session id.

Recommended model:

```ts
interface DesktopSessionSummary {
  id: string;
  repoId: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  status: "idle" | "running" | "waiting_approval" | "failed";
  model?: string;
  promptTokens?: number;
  costUsd?: number;
}
```

UI surfaces:

- Session list in sidebar.
- Session command menu.
- Empty state: "New session".
- Search box.
- Sort by recent activity.

## 4. Stream Event Coverage

Current problem:

`applyStreamEvent()` handles only:

- `stream_request_start`
- `text_delta`
- `tool_use_start`
- `tool_result`
- `turn_complete`
- `error`

Core supports more events:

- `session_started`
- `tool_use_args_delta`
- `assistant_message`
- `tombstone`
- `task_update`
- `thinking_delta`
- `agent_start`
- `agent_end`
- `tool_summary`
- `context_compact`
- `usage_update`

Missing UI effects:

- Show authoritative session id from `session_started`.
- Render thinking state from `thinking_delta`.
- Update tool args live from `tool_use_args_delta`.
- Display tasks from `task_update`.
- Show sub-agent start/end cards.
- Show context compaction boundary.
- Show context/token usage from `usage_update`.
- Handle tombstones/removals.

Recommended reducer expansion:

```ts
type Message =
  | UserMessage
  | AssistantMessage
  | ThinkingMessage
  | ToolMessage
  | TaskListMessage
  | AgentMessage
  | ContextBoundaryMessage
  | SystemMessage;
```

## 5. Tool Call Visualization

Current problem:

`ToolCallBlock.tsx` displays every tool call as one generic collapsible JSON block.

Required Codex-style behavior:

- Tool-specific cards.
- Compact one-line summary by default.
- Rich detail view in inspector.
- Stable status indicators:
  - queued
  - running
  - succeeded
  - failed
  - denied
  - cancelled
- Duration and timestamps.
- Copy result/args.
- Open file/open folder actions where safe.

Tool-specific renderers to add:

| Tool type | Main stream card | Inspector detail |
|---|---|---|
| Bash | command, cwd, running spinner, exit status | stdout/stderr tabs, full command, duration |
| Read | file path, line range | file preview with line numbers |
| Write/Edit/ApplyPatch | file path, insert/delete summary | unified diff |
| Grep/Glob | pattern and match count | result list |
| WebFetch/WebSearch | URL/query | fetched title, excerpt, citations |
| Agent | sub-agent name and task | sub-agent transcript/status |
| TaskCreate/TaskUpdate | task summary | task board |
| Cron/Sleep/Automation | schedule/delay | next run/status |
| MCPTool | server/tool name | structured request/result |

Recommended component split:

```text
ToolCallBlock.tsx
tool-cards/
  BashToolCard.tsx
  FileToolCard.tsx
  DiffToolCard.tsx
  SearchToolCard.tsx
  AgentToolCard.tsx
  McpToolCard.tsx
  GenericToolCard.tsx
```

## 6. Diff And File Change Review

Current problem:

The GUI has no first-class file-change review. This is one of the biggest gaps for a coding agent desktop app.

Required UI:

- Changed files list.
- Inline unified diff viewer.
- Side-by-side diff option later.
- Per-file status:
  - added
  - modified
  - deleted
  - renamed
- Per-tool diff association.
- Git status summary.
- Open changed file.
- Copy patch.
- Revert file or hunk later, behind approval.
- Show generated file artifacts.

Recommended first version:

- Add right inspector tab: `Diff`.
- Add IPC query: `getGitDiff(cwd, file?)`.
- Render unified diff with syntax-aware classes:
  - added lines
  - removed lines
  - hunk headers
  - file headers
- Link tool cards that edited files to the diff inspector.

## 7. Approval Center

Current problem:

Approval is currently a modal with raw args and approve/deny buttons.

Missing behavior:

- Queue of pending approvals.
- Badge in sidebar/topbar.
- Risk-aware layout.
- Diff preview for write/edit/bash-dangerous actions.
- Command preview for shell tools.
- "Approve once" vs "allow for session/workspace" design.
- Deny reason presets.
- Timeout state.
- History of approved/denied actions.

Recommended UI:

- Keep modal for blocking flow.
- Add an `Approvals` view for all pending approvals.
- Add approval detail in inspector.
- Show:
  - tool name
  - risk level
  - cwd
  - generated summary
  - raw args collapsed
  - expected file changes when available

## 8. Model, Permission, Settings UI

Current problem:

Desktop reads settings indirectly through the worker, but there is no settings UI.

Required screens:

- Model selector.
- Provider/API key status.
- Permission mode:
  - plan
  - normal/default
  - accept edits
  - bypass
- Sandbox settings.
- MCP server configuration.
- Hooks configuration.
- Project settings vs user settings.
- Feature flags.

Top bar should always show:

- active model
- permission mode
- current context usage
- whether tools require approval

Needed backend/preload additions:

- `getSettings`
- `updateSettings`
- `listModels`
- `setModel`
- `configure`
- `query`

## 9. Task And Sub-Agent Surfaces

Current problem:

The core supports tasks and sub-agents, but the desktop renderer does not visualize them beyond generic stream events.

Missing UI:

- Task list panel.
- Task progress states.
- Sub-agent dock/list.
- Background agent completion notification.
- Agent detail transcript.
- Agent error/success states.
- Ability to switch between main agent and sub-agent view.

Relevant events:

- `task_update`
- `agent_start`
- `agent_end`

Recommended UI:

- Right inspector tab: `Tasks`.
- Main stream compact cards:
  - "Agent started"
  - "Agent completed"
  - "Task updated"
- Sidebar/runs badge for active background work.

## 10. Runs Dashboard

Current problem:

Core has `RunManager` and run persistence, but Electron UI does not expose it.

Required UI:

- Runs list.
- Run statuses:
  - queued
  - running
  - waiting_input
  - waiting_approval
  - completed
  - failed
  - cancelled
- Checkpoint view.
- Artifact list.
- Resume/cancel/recover actions.
- Run event stream.

This can be a separate top-level sidebar view after chat/session basics are stable.

## 11. Search

Current problem:

Sidebar has "搜索", but there is no search surface.

Search scopes to support:

- Current transcript.
- All sessions.
- Repos/workspaces.
- Tool calls.
- Files in selected repo.
- Logs.

Recommended first version:

- Transcript search in current session.
- Highlight matching messages.
- Keyboard shortcut: `Cmd+F`.

## 12. Command Palette

Missing:

- Global command palette similar to desktop productivity apps.

Commands:

- New session.
- Open repo.
- Switch repo.
- Switch session.
- Toggle inspector.
- Toggle sidebar.
- Change model.
- Change permission mode.
- Open settings.
- Show logs.
- Clear transcript.
- Run slash command.

Shortcut:

- `Cmd+K` or `Cmd+Shift+P`.

## 13. Input Composer

Current problem:

The input box supports basic text, IME, history, and stop/send. It is not yet a full coding-agent composer.

Missing:

- Attachment/context pills.
- File mention/autocomplete.
- Slash command autocomplete.
- Model/permission controls near composer.
- Multiline controls with stable height.
- Token estimate for draft.
- Clear draft.
- Paste image/file handling later.
- Submit variants:
  - send
  - plan only
  - continue
  - review diff

Recommended first version:

- Add a compact composer toolbar:
  - current mode
  - model
  - cwd
  - send/stop icon button
  - slash command hint

## 14. Markdown And Code Rendering

Current behavior:

- Completed assistant messages use `react-markdown`.
- Streaming assistant messages render plain text.
- Code highlighting uses highlight.js GitHub CSS.

Missing:

- Copy code button.
- Code block language label.
- Horizontal scroll polish.
- Mermaid support maybe later.
- Tables with better overflow.
- Anchored headings or message actions.
- Message menu:
  - copy
  - retry
  - quote
  - inspect

Recommended:

- Add a `CodeBlock` component to Markdown overrides.
- Add message-level actions on hover.

## 15. Long Transcript Performance

Current problem:

`MessageStream` maps every message and scrolls to the end on every message array change.

Risks:

- Long sessions will become slow.
- Smooth scroll on every delta can jitter.
- Markdown render after completion can reflow heavily.

Needed:

- Virtualized message list.
- Stick-to-bottom logic:
  - auto-scroll only if user is already near bottom
  - pause auto-scroll when user scrolls up
- Coalesced text deltas before React state updates.
- Memoized message rows.
- Lazy expansion for large tool outputs.
- Output truncation with "show more".

Recommended first version:

- Replace `scrollIntoView({ behavior: "smooth" })` with a stick-to-bottom hook.
- Memoize message rows.
- Add max-height and lazy rendering for tool output.

## 16. Visual System

Current problem:

All UI styles live in one CSS file and read as MVP. The palette is mostly beige/light and lacks a reusable design system.

Required:

- CSS tokens:
  - color
  - spacing
  - font
  - border radius
  - shadows
  - z-index
- Light/dark theme.
- Shared components:
  - icon button
  - tabs
  - sidebar row
  - toolbar
  - badge
  - modal
  - popover
  - tooltip
  - segmented control
  - status dot
- Consistent hover/focus/active/disabled states.
- Keyboard focus rings.
- Dense layout suitable for coding workflows.

Recommended file split:

```text
styles/
  tokens.css
  base.css
  layout.css
  sidebar.css
  chat.css
  tool-cards.css
  modal.css
  inspector.css
```

## 17. Desktop Native Polish

Missing:

- App menu.
- Recent projects.
- Native open folder.
- Open external links via Electron `shell.openExternal`.
- Reveal file in Finder.
- Notifications for background completion.
- Dock/taskbar badge for pending approvals.
- Window state persistence.
- Proper app icon.
- Packaged build.
- Auto-update.

## 18. Security And Trust

Current good baseline:

- `contextIsolation: true`
- `nodeIntegration: false`
- Narrow preload API

Concern:

- `sandbox: false` in `BrowserWindow` should be revisited before production.

Missing:

- Workspace trust UI.
- Explicit trust before running tools in a repo.
- CSP hardening beyond current MVP.
- Strict external link handling through main process.
- Backend-side validation for approval decisions.
- Typed validation of IPC inputs.
- Safe file opening/reveal APIs.

## Recommended Roadmap

## Phase 1: UI Shell Foundation

Goal: make the app feel like a real desktop workspace.

Tasks:

- Add `TopBar` to `App`.
- Add right `InspectorPanel`.
- Add `viewMode` state for sidebar nav.
- Turn sidebar menu items into clickable buttons.
- Add status badges for busy repo and pending approval.
- Split CSS into layout and component sections.
- Add icon library.

Deliverable:

- Three-region app shell: sidebar, chat, inspector.

## Phase 2: Session And Stream State

Goal: make the UI understand what the agent is actually doing.

Tasks:

- Handle `session_started`.
- Store active `sessionId`.
- Add session list model.
- Add `thinking_delta` rendering.
- Add `usage_update` context display.
- Add `tool_use_args_delta` live updates.
- Add `task_update`, `agent_start`, `agent_end` cards.
- Add context compaction boundary messages.

Deliverable:

- Desktop shows session identity, token state, thinking, tasks, and sub-agents.

## Phase 3: Tool Cards And Inspector

Goal: stop rendering every tool as raw JSON.

Tasks:

- Split tool card renderers by tool name/type.
- Add selected tool state.
- Render selected tool in inspector.
- Add copy buttons.
- Add duration/status display.
- Add lazy large-output rendering.

Deliverable:

- Chat stream becomes readable; details move to inspector.

## Phase 4: Diff And Approval Review

Goal: support coding-agent safety workflows.

Tasks:

- Add git status query.
- Add git diff query.
- Add diff viewer.
- Add changed files list.
- Upgrade approval modal.
- Add Approvals view.
- Link approval to diff/tool inspector.

Deliverable:

- User can inspect and approve risky changes with context.

## Phase 5: Settings, Models, Runs

Goal: expose core product power in GUI.

Tasks:

- Add settings view.
- Add model selector.
- Add permission mode control.
- Add MCP settings.
- Add runs dashboard.
- Add logs/perf viewer.

Deliverable:

- Electron becomes a real visual control surface for CodeShell.

## P0 Checklist For Next UI Pass

- [ ] Wire `TopBar` into `App`.
- [ ] Add `InspectorPanel`.
- [ ] Make sidebar nav real.
- [ ] Add active repo/session header.
- [ ] Add pending approval badge.
- [ ] Add model/permission/context indicators.
- [ ] Expand renderer `Message` model.
- [ ] Handle `session_started`.
- [ ] Handle `thinking_delta`.
- [ ] Handle `usage_update`.
- [ ] Handle `task_update`.
- [ ] Handle `agent_start` and `agent_end`.
- [ ] Split generic tool block into tool cards.
- [ ] Add selected tool inspector.
- [ ] Replace smooth-scroll-every-update with stick-to-bottom logic.

## P1 Checklist

- [ ] Session list.
- [ ] Session create/rename/delete.
- [ ] Transcript search.
- [ ] Tool output copy buttons.
- [ ] Code block copy buttons.
- [ ] Diff viewer.
- [ ] Approval center.
- [ ] Settings view.
- [ ] Model selector.
- [ ] Permission mode control.
- [ ] Workspace trust UI.

## P2 Checklist

- [ ] Runs dashboard.
- [ ] Logs/perf viewer.
- [ ] MCP management UI.
- [ ] Command palette.
- [ ] Native app menu.
- [ ] Desktop notifications.
- [ ] Packaged app.
- [ ] Auto-update.
- [ ] Multi-window support.

## Implementation Notes

- Keep the renderer as a thin client. Do not import runtime core logic into renderer.
- Prefer typed preload APIs over ad hoc IPC strings.
- Keep tool details in the inspector when possible; the chat stream should stay readable.
- Avoid building a terminal emulator as the main UI. Use normal web layout and components.
- Optimize for dense coding workflows, not landing-page visuals.
- Add visual regression checks once the shell stabilizes.

