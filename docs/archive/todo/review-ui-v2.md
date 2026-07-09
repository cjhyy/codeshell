## Desktop UI Review

### Strengths (file:line specific)
- `packages/desktop/src/renderer/Markdown.tsx:66` and `:180` keep raw HTML behind `rehypeRaw` followed by `rehypeSanitize`, and `Markdown.test.tsx:69` covers script/event/style/iframe stripping plus highlight-class preservation.
- `packages/desktop/src/main/runs-service.ts:117` validates run IDs before filesystem access; `runs-service.test.ts:29` covers separator, traversal, and alias rejection.
- `packages/desktop/src/main/pty-service.ts:177` validates PTY cwd before spawn, and `TerminalPanel.tsx:78` shows structured start failures instead of silently failing.
- `packages/desktop/src/renderer/App.tsx:412` keeps transcript state in a ref, and `streamRouting.ts:68` returns ask-user answers so timeout handling does not overwrite resolved answers.
- `packages/desktop/src/main/browser-host/index.ts:50` uses hardened login window options, and `:150` clears all partition storage after credential login.
- `packages/desktop/src/preload/types.d.ts:7` and `App.tsx:2` use type-only core imports, preserving the renderer rule against runtime-importing codeshell packages.

### Critical (Must Fix Before Tag)
- `packages/desktop/src/renderer/topbar/WorkspaceIndicator.tsx:65`, `:345`, `:395`, `:398`; `packages/desktop/src/main/session-workspace-service.ts:126`, `:139`, `:149`: occupied worktrees are only labeled, not blocked. The cleanup menu still enables detach/discard for a worktree owned by another session, and the main service does not reject targets present in `workspaceOwners(sm)`. `discard` can remove a worktree another active session is using, including dirty state whose base ref is unknown to the current session. Main must fail closed for other-session ownership, and the UI should disable those actions.
- `packages/desktop/src/main/index.ts:2661`, `:2679`, `:2691`; `packages/desktop/src/main/session-workspace-service.ts:35`, `:96`, `:112`, `:126`; `packages/desktop/src/preload/index.ts:460`: workspace IPC accepts arbitrary non-empty `sessionId`/`cwd`. `switchSessionWorkspaceForUi` can create a git worktree before `setSessionWorkspace` discovers the session is unknown, leaving orphan worktrees/branches. `cleanupSessionWorktreeForUi` can remove matched worktrees for an unknown session. Mutating workspace IPC should require an existing session and derive roots from trusted session state.

### Important (Should Fix Before Tag)
- `packages/desktop/src/renderer/browser/useBrowserTabs.ts:196`, `:201`, `:204`, `:214`: the injected target-blank bridge accepts synthetic click events. Because the page can dispatch a click that the injected listener converts into the privileged console sentinel, untrusted webview content can open tabs without a real user gesture. Add `e.isTrusted` checking and tests for synthetic clicks.
- `packages/desktop/src/renderer/topbar/WorkspaceIndicator.tsx:101`, `:117`, `:129`: async workspace refreshes have no cancellation or request sequencing. A slow response from a previous `sessionId`/`repoPath` can overwrite the current session's indicator/list, and unmount can still call `setState`. Add a request id or cancelled flag.
- `packages/desktop/src/renderer/topbar/WorkspaceIndicator.test.tsx:13`, `:30`, `:39`: the new tests mostly cover exported helper functions and even encode that occupied rows are selectable. They do not render the component or verify bridge calls, loading/error states, cleanup confirmation, busy disabling, occupied cleanup blocking, or stale refresh behavior.

### Minor (Nice to Have)
- `packages/desktop/src/renderer/TopBar.tsx:95` plus `WorkspaceIndicator.tsx:44`: the header can render duplicate repo naming, e.g. `code-shell / codeshell` next to `main (codeshell)`. Since the repo name is already adjacent, the workspace chip should likely show just `main`.

### Assessment (Ready to tag? No)
The Markdown and preload/type-only architecture work is generally solid, but the new workspace UI and IPC path expose destructive git operations without sufficient session ownership validation. Fix the occupied-worktree and unknown-session cases before tagging, then add behavioral tests around the renderer/main bridge.
