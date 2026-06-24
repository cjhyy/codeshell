# Electron Codex UI — Full Build Design

> Date: 2026-05-24
> Source gap analysis: 已实现并于 2026-06-25 归档清理删除(实现已在码内,见 docs/feature-inventory.md)
> Scope: implement the complete roadmap (Phase 1-5) and full P0/P1/P2 checklists from the gap analysis. This spec covers every section of that document.

## 1. Goal

Turn the current `packages/desktop` MVP into a Codex-style desktop coding agent workspace:

- A three-region application shell (sidebar, main, inspector) with a top bar.
- Renderer that understands every `StreamEvent` the core emits.
- Tool-call rendering split into tool-specific cards.
- Diff and approval review surfaces with risk context.
- Settings, models, permissions, MCP, hooks, and runs all controllable from the GUI.
- Native desktop polish (menu, recents, notifications, packaging, auto-update).
- Hardened security model (workspace trust, sandboxed BrowserWindow, validated IPC).

The deliverable is feature-parity with the gap analysis, not pixel-parity with Codex.

## 2. Non-Goals

- Pixel-identical clone of Codex.
- Embedded terminal emulator as the main UI surface.
- Editor surface (we are an agent client, not VS Code).
- Cross-machine sync / accounts.
- A web build — Electron only.

## 3. Architectural Principles

- **Renderer is a thin client.** No core runtime imports in renderer; only `import type` is allowed (lint already enforces this).
- **Typed preload only.** Every `window.codeshell.*` method has a TypeScript signature and a zod input validator in the preload layer.
- **Main owns desktop services.** Git diff, file system metadata, settings file IO, recents, window state — all live in `main`. The agent worker stays focused on engine work.
- **Stream events are the source of truth for in-session UI.** Persistence is a cache, not a fact source.
- **Boundaries by feature folder.** Each major view (`chat/`, `approvals/`, `runs/`, `settings/`, `sessions/`, `logs/`, `mcp/`, `diff/`) is a folder; cross-cutting primitives go in `ui/`.
- **CSS via tokens + per-component files.** No more single `styles.css`.

## 4. Top-Level Layout

```
+─────────────────────── TopBar ─────────────────────────+
| app · repo · session title · branch · model · mode ·    |
| tokens · status dot                                     |
+──────┬─────────────────────────────────────────┬────────+
|      |                                         |        |
| Side | Main (viewMode-driven)                  | Insp   |
| bar  |                                         | ector  |
|      |                                         |        |
+──────┴─────────────────────────────────────────┴────────+
```

- Three CSS grid columns, both side columns collapsible to a thin rail.
- `viewMode` switches main between `chat | sessions | runs | approvals | settings | mcp | logs`.
- Inspector tabs are selection-driven: `Args/Result | Diff | Logs | Approval | Tasks`.

## 5. Module Layout (target)

```
packages/desktop/src/
  main/
    index.ts                # window lifecycle, menu, recents, window-state
    agent-bridge.ts         # spawn + JSON-RPC pipe (existing)
    desktop-services.ts     # git status/diff, openExternal, revealInFinder
    settings-service.ts     # read/write ~/.code-shell/settings.json
    sessions-service.ts     # list/load/new/rename/delete session files
    runs-service.ts         # list/get/resume/cancel + run event tail
    mcp-service.ts          # list/connect/disconnect MCP servers
    logs-service.ts         # tail ~/.code-shell/logs/*
    recents-store.ts        # ~/.code-shell/desktop/recents.json
    window-state-store.ts   # ~/.code-shell/desktop/window.json
    menu.ts                 # native app menu
    ipc.ts                  # ipcMain.handle wiring + zod validation
    notifications.ts        # Notification + dock badge
    updater.ts              # electron-updater wiring (mac only initially)
  preload/
    index.ts                # contextBridge.exposeInMainWorld
    types.d.ts              # CodeshellApi type
    schemas.ts              # zod input schemas for every API
  renderer/
    main.tsx
    App.tsx
    state/
      store.ts              # Zustand store (replaces useReducer monolith)
      transcripts.ts        # transcript persistence
      sessions.ts
      approvals.ts
      runs.ts
      settings.ts
      selection.ts
      view.ts               # viewMode + sidebar/inspector collapsed
      stream-reducer.ts     # applyStreamEvent (expanded for all events)
    ui/
      Button.tsx
      IconButton.tsx
      Badge.tsx
      StatusDot.tsx
      Tabs.tsx
      SegmentedControl.tsx
      Tooltip.tsx
      Popover.tsx
      Kbd.tsx
      EmptyState.tsx
      Modal.tsx
      Spinner.tsx
      CopyButton.tsx
      icons.tsx             # re-export lucide-react icons
    shell/
      TopBar.tsx
      Sidebar.tsx
      SidebarNav.tsx
      SidebarRepoList.tsx
      SidebarSessionList.tsx
      SidebarBadges.tsx
      InspectorPanel.tsx
      CommandPalette.tsx    # Cmd+K
      SearchBar.tsx         # Cmd+F transcript search
    chat/
      ChatView.tsx
      MessageStream.tsx     # virtualized
      Composer.tsx          # textarea + mode/model/cwd toolbar
      stick-to-bottom.ts
      Markdown.tsx
      CodeBlock.tsx
    messages/
      UserMessage.tsx
      AssistantMessage.tsx
      ThinkingMessage.tsx
      AgentMessage.tsx
      TaskListMessage.tsx
      ContextBoundaryMessage.tsx
      SystemMessage.tsx
    tool-cards/
      index.ts              # name → component dispatcher
      BashToolCard.tsx
      FileReadCard.tsx
      FileWriteCard.tsx
      EditCard.tsx
      ApplyPatchCard.tsx
      GrepGlobCard.tsx
      WebCard.tsx
      AgentCard.tsx
      TaskCard.tsx
      McpCard.tsx
      GenericToolCard.tsx
      ToolStatusDot.tsx
    sessions/
      SessionsView.tsx
      SessionListItem.tsx
      SessionRenameDialog.tsx
    approvals/
      ApprovalModal.tsx     # current modal, kept for blocking
      ApprovalsView.tsx     # full queue
      ApprovalCard.tsx
      RiskPill.tsx
    diff/
      ChangedFilesList.tsx
      UnifiedDiffViewer.tsx
      parse-unified-diff.ts
    runs/
      RunsView.tsx
      RunListItem.tsx
      RunDetail.tsx
      CheckpointList.tsx
    settings/
      SettingsView.tsx
      ModelSection.tsx
      ProviderSection.tsx
      PermissionSection.tsx
      McpSection.tsx
      HooksSection.tsx
      FeatureFlagsSection.tsx
      ProjectVsUserToggle.tsx
    mcp/
      McpView.tsx
    logs/
      LogsView.tsx
    workspace-trust/
      TrustGate.tsx
      trust-store.ts
    styles/
      tokens.css
      base.css
      layout.css
      topbar.css
      sidebar.css
      chat.css
      composer.css
      tool-cards.css
      messages.css
      inspector.css
      modal.css
      approval.css
      diff.css
      settings.css
      runs.css
      sessions.css
      logs.css
      mcp.css
      palette.css
      markdown.css
    styles.css              # @import the above in order
```

## 6. State Management

Replace the current `useReducer` in `App.tsx` with a Zustand store (small, no boilerplate, plays well with selectors). Slices:

- `transcripts` — per-repo `MessagesReducerState` (existing semantics extended).
- `sessions` — session summaries + active id.
- `approvals` — pending queue + history.
- `runs` — list + active subscription.
- `settings` — last-fetched settings snapshot + dirty staging.
- `selection` — `{kind, id} | null` driving Inspector.
- `view` — `viewMode`, `sidebarCollapsed`, `inspectorCollapsed`, `theme`.
- `repos` — existing.
- `lifecycle` — banner text, busy keys, runningRepoKey.

Rationale: the current `useReducer + multiple useState` pattern won't scale once Inspector, Approvals queue, Sessions, and Runs all need read access to overlapping state. Zustand selectors keep re-render scope tight.

### Expanded Message model

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

ToolMessage gains:

```ts
{
  kind: "tool";
  id: string;
  toolName: string;
  args: string;
  argsLive?: Record<string, unknown>; // tool_use_args_delta accumulator
  result?: string;
  error?: string;
  status: "queued" | "running" | "succeeded" | "failed" | "denied" | "cancelled";
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
}
```

`MessagesReducerState` gains:

```ts
{
  messages: Message[];
  streamingAssistantId: string | null;
  streamingThinkingId: string | null;
  sessionId: string | null;
  promptTokens: number;
  tasks: TaskInfo[];
  activeAgents: Record<agentId, AgentRuntime>;
}
```

### Stream event coverage

`applyStreamEvent` MUST handle every event listed in `packages/core/src/types.ts` `StreamEvent` union:

| Event | UI effect |
|---|---|
| `session_started` | set `sessionId`, `promptTokens`; create session summary if new |
| `stream_request_start` | open assistant message (existing) |
| `text_delta` | append to streaming assistant text (existing) |
| `thinking_delta` | append to streaming thinking message |
| `tool_use_start` | append tool message, status=running, startedAt=now |
| `tool_use_args_delta` | update `argsLive` for matching toolCallId |
| `tool_result` | set result/error, status=succeeded\|failed, endedAt=now |
| `assistant_message` | finalize streaming assistant message |
| `tombstone` | remove message by id |
| `task_update` | replace `tasks` snapshot + emit/refresh TaskListMessage |
| `agent_start` | append AgentMessage, mark activeAgents[agentId] |
| `agent_end` | finalize AgentMessage, clear activeAgents[agentId] |
| `tool_summary` | attach summary to most-recent tool message |
| `context_compact` | append ContextBoundaryMessage |
| `usage_update` | update `promptTokens` |
| `turn_complete` | clear streaming ids, status banner OK |
| `error` | append SystemMessage, clear streaming |

## 7. IPC / Preload API (full surface)

```ts
interface CodeshellApi {
  // existing
  run, cancel, approve, onStreamEvent, onApprovalRequest,
  onStatus, onAgentLifecycle, pickDir, log,

  // query (read-only RPC passthrough)
  query<T = unknown>(method: string, params?: unknown): Promise<T>;

  // configure (writes)
  configure(patch: {
    planMode?: boolean;
    permissionMode?: "plan" | "default" | "accept_edits" | "bypass";
    sandbox?: SandboxConfig;
    featureFlags?: Record<string, boolean>;
  }): Promise<void>;

  // sessions
  listSessions(repoId?: string): Promise<DesktopSessionSummary[]>;
  loadSession(id: string): Promise<DesktopSessionPayload>;
  newSession(opts: { repoId: string; title?: string }): Promise<DesktopSessionSummary>;
  renameSession(id: string, title: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  onSessionChanged(cb): Unsubscribe;

  // runs
  listRuns(opts?: { repoId?: string; status?: RunStatus }): Promise<RunSummary[]>;
  getRun(id: string): Promise<RunDetail>;
  resumeRun(id: string): Promise<void>;
  cancelRun(id: string): Promise<void>;
  onRunEvent(cb): Unsubscribe;

  // settings / models
  getSettings(scope: "user" | "project"): Promise<Settings>;
  updateSettings(scope: "user" | "project", patch: DeepPartial<Settings>): Promise<void>;
  listModels(): Promise<ModelInfo[]>;
  setActiveModel(modelId: string): Promise<void>;
  validateProviderKey(provider: string, apiKey: string): Promise<{ ok: boolean; message?: string }>;

  // MCP
  listMcpServers(): Promise<McpServerStatus[]>;
  connectMcpServer(name: string): Promise<void>;
  disconnectMcpServer(name: string): Promise<void>;

  // git / fs
  getGitStatus(cwd: string): Promise<GitStatus>;
  getGitDiff(cwd: string, file?: string): Promise<string>; // unified
  openExternal(url: string): Promise<void>;
  revealInFinder(path: string): Promise<void>;

  // logs
  tailLog(bucket: "ui-ink" | "engine" | "desktop", lines?: number): Promise<string[]>;
  subscribeLog(bucket, cb): Unsubscribe;

  // workspace trust
  getTrust(repoPath: string): Promise<TrustState>;
  setTrust(repoPath: string, level: "trusted" | "untrusted"): Promise<void>;

  // window / native
  recentProjects(): Promise<{ path: string; name: string; lastOpenedAt: number }[]>;
  pushRecent(path: string): Promise<void>;
  notify(opts: { title: string; body?: string; subtitle?: string }): Promise<void>;
  setBadgeCount(n: number): Promise<void>;
}
```

Every method has:
- A zod schema for params in `preload/schemas.ts`.
- A handler in `main/ipc.ts` that re-validates server-side.
- A typed return.

## 8. Phase Breakdown (delivery slices)

Each phase is one or more PRs. Within a phase, sub-tasks are independent and PR-able separately.

### Phase 1 — UI Shell Foundation

- [ ] CSS tokens + per-component CSS files (no behavior change yet).
- [ ] Add `lucide-react`; replace emoji icons.
- [ ] Convert `app-grid` to three-column layout (collapsible side rails).
- [ ] Wire `TopBar` into `App` with repo / branch / model / mode / tokens / status.
- [ ] `InspectorPanel` shell with empty state.
- [ ] `SidebarNav` with active state, click-to-switch, badge slots.
- [ ] `viewMode`, `selection`, `sidebarCollapsed`, `inspectorCollapsed` state.
- [ ] Empty states for each viewMode.
- [ ] Theme tokens + light/dark; `prefers-color-scheme` default.

**Deliverable:** the app feels like a workspace with real navigation. Chat still works as before.

### Phase 2 — Session and Stream State

- [ ] Introduce Zustand store; migrate transcripts/lifecycle/repos/approvals to slices.
- [ ] Expand `Message` union + reducer state.
- [ ] Handle every `StreamEvent` listed in §6.
- [ ] Render `ThinkingMessage`, `AgentMessage`, `TaskListMessage`, `ContextBoundaryMessage`.
- [ ] Session list: title (first user prompt), updated/created times, status, tokens, model.
- [ ] Sidebar session list under active repo.
- [ ] `session_started` binds UI session id to engine session id.
- [ ] TopBar tokens come from `usage_update`; status from streaming flags.

**Deliverable:** UI accurately reflects what the agent is doing.

### Phase 3 — Tool Cards and Inspector

- [ ] Tool card dispatcher + per-tool components per §5.
- [ ] One-line summary in chat; expansion + selection routes to Inspector.
- [ ] `ToolMessage.status` lifecycle wiring.
- [ ] Copy buttons for args/result.
- [ ] Lazy-render large outputs (truncate + show more).
- [ ] Inspector tabs: `Args/Result | Logs | Tasks` (Diff/Approval added in Phase 4).
- [ ] `tool_summary` rendered as inline subtitle.
- [ ] Open-file / reveal-in-finder where safe (read/write tools).

**Deliverable:** chat stream is readable, details live in Inspector.

### Phase 4 — Diff and Approval Review

- [ ] `desktop-services.ts` git status + git diff (spawn `git` in `cwd`).
- [ ] `parse-unified-diff.ts` + `UnifiedDiffViewer`.
- [ ] `ChangedFilesList` in Inspector when run touches files.
- [ ] Tool cards for Write/Edit/ApplyPatch link to Diff inspector.
- [ ] `ApprovalsView` listing queued approvals.
- [ ] `ApprovalQueue` slice; sidebar/topbar badge.
- [ ] `ApprovalCard` with risk pill, summary, raw args collapsed.
- [ ] "Approve once" / "Allow for session" buttons (latter behind feature flag if backend not ready).
- [ ] Deny reason presets.
- [ ] Approval history kept in memory + persisted per session.
- [ ] Inspector `Approval` tab.

**Deliverable:** users can inspect and approve risky changes with context.

### Phase 5 — Settings, Models, Runs, Logs, MCP

- [ ] Extend preload with remaining APIs (§7).
- [ ] `main/ipc.ts` + per-service modules implement them.
- [ ] `SettingsView` with sections (general/models/providers/permissions/mcp/hooks/project/flags).
- [ ] Provider key validation flow.
- [ ] Model selector (TopBar + Settings).
- [ ] Permission mode segmented control (TopBar + Settings).
- [ ] `RunsView` with statuses, checkpoints, artifacts, resume/cancel.
- [ ] `LogsView` tailing `~/.code-shell/logs/*`.
- [ ] `McpView` with connect/disconnect + tool list.

**Deliverable:** GUI is a full control surface for code-shell.

### Phase 6 — Native polish, search, palette, security (covers P2 + cross-cutting)

- [ ] Native app menu with Recent Projects submenu.
- [ ] Window state persistence.
- [ ] `Notification` for background completion; dock badge for pending approvals.
- [ ] `Cmd+K` command palette.
- [ ] `Cmd+F` transcript search.
- [ ] External link routing through `shell.openExternal`.
- [ ] `sandbox: true` on BrowserWindow + CSP hardening.
- [ ] Workspace trust modal on first use of a repo.
- [ ] zod-validated IPC at both preload and main boundaries.
- [ ] `electron-builder` config (mac dmg + zip); signing/notarize TODO with placeholder.
- [ ] `electron-updater` wiring (mac stable channel).
- [ ] Multi-window support (`New Window` menu).
- [ ] App icon assets.

## 9. Performance plan

- `react-window` or `@tanstack/react-virtual` for `MessageStream`.
- `text_delta` / `thinking_delta` coalesced via `requestAnimationFrame` before store updates.
- Memoized row components keyed by `message.id`.
- Lazy expansion for tool outputs > N lines (default 200).
- Stick-to-bottom hook replaces `scrollIntoView({behavior:"smooth"})` per delta.
- Transcript persistence: existing 600ms debounce stays; switch to `requestIdleCallback` when available.
- Per-repo session files written separately so persistence cost scales with active session not full map.

## 10. Visual system

- CSS custom properties for color/spacing/font/radius/shadow/z-index.
- Themes: `data-theme="light"` default, `data-theme="dark"` overrides; `data-theme="system"` follows OS.
- Dense layout (row height 28-32px in lists, line-height 1.4 in chat).
- Focus rings visible on keyboard navigation.
- Shared primitives (§5 `ui/`) drive consistency.

## 11. Security and trust

- `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`.
- CSP: `default-src 'self'`, `style-src 'self' 'unsafe-inline'` (Markdown CSS needs inline; revisit), `script-src 'self'`, no remote scripts.
- All renderer→main IPC goes through `ipcMain.handle` with zod-validated params.
- External links: renderer never opens URLs; uses `openExternal`.
- File reveal: only paths inside trusted repo `cwd` are allowed (path-prefix check in main).
- Workspace trust:
  - First add of a repo → trust prompt.
  - Untrusted repos: write tools auto-deny, approval prompts noop with explanation, read tools allowed.
  - Trust state stored in `~/.code-shell/desktop/trust.json`.
- Approval decisions: main validates that the originating `requestId` is still pending before forwarding.

## 12. Testing

- Unit (Vitest):
  - `applyStreamEvent` for every event type.
  - Stick-to-bottom hook (manual scroll vs auto-scroll).
  - `parse-unified-diff`.
  - Approval queue reducer.
  - Preload zod schemas reject malformed inputs.
- Component (Vitest + React Testing Library):
  - Tool card dispatcher chooses right card per tool name.
  - SidebarNav active state.
  - InspectorPanel renders correct tab per selection kind.
- Integration (Playwright via existing webapp-testing harness):
  - End-to-end golden path: add repo → send message → tool runs → result.
  - Approval flow.
  - Diff viewer on a real git repo fixture.
- Visual regression added after Phase 1 stabilizes (Storybook or Playwright screenshots).

## 13. Migration / Backwards Compatibility

- Existing `localStorage` transcripts read once and migrated into the new sessions store; old key kept for one release as fallback.
- Old preload methods remain identical; new ones additive.
- Renderer continues to work if any new preload method is missing (feature-detect, hide UI).

## 14. Risks

- **Scope.** This is a multi-PR effort. Mitigation: phase boundaries with shippable deliverables.
- **Backend gaps.** Sessions/runs/settings IPC may need core extensions. Mitigation: each service module defines an interface; first impl can stub from local fs (`~/.code-shell/`).
- **Virtualization + markdown.** Variable-height rows with markdown are tricky. Mitigation: start with `@tanstack/react-virtual` dynamic-size measuring; if jitter, fall back to fixed-height tool/system rows and only virtualize assistant blocks.
- **Sandbox + dialog.** `sandbox: true` may break some Electron APIs we use; verify `dialog:pickDir` still works (it's `ipcMain.handle`, should be fine).
- **Signing / notarize.** Requires Apple credentials; left as TODO in Phase 6 packaging.

## 15. Acceptance Criteria

The work is complete when:

1. All P0/P1/P2 checklist items in the gap analysis are checked.
2. Three-region shell renders and is usable.
3. Every `StreamEvent` from core has a UI representation.
4. Tool cards are split per tool name; raw JSON view is fallback only.
5. Diff viewer renders unified diffs from git.
6. Approval queue with badge works; approvals can be inspected in Inspector.
7. Settings view writes through to `~/.code-shell/settings.json` and reloads worker.
8. Runs view lists runs and supports resume/cancel.
9. `Cmd+K` palette opens; `Cmd+F` searches the current transcript.
10. App can be packaged via `electron-builder` (signing optional).
11. `sandbox: true`, zod-validated IPC, external links go through `openExternal`.
12. Vitest suite passes; Playwright golden path passes.
