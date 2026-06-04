# CodeShell Workbench Built-ins Design（Future）

Date: 2026-06-04
Status: Future design / backlog candidate
Scope: Desktop-first, core-compatible built-in workbench capabilities

> This document captures future product direction. It does **not** describe shipped behavior unless explicitly marked as current state. The goal is to preserve the design shape for later implementation after current release/stabilization work.

## 1. Background

Recent Codex comparisons surfaced a practical gap: a coding agent is more useful when core workbench capabilities are treated as first-class product features, not merely as raw tool calls.

The capabilities called out here are:

- File reading / file viewing
- Browser interaction
- Terminal execution and command review
- File change review
- Code change review

CodeShell already has several lower-level primitives for these workflows, including file tools, shell tools, browser/MCP integration paths, patch editing, and subagents. The missing layer is a cohesive workbench experience that makes those capabilities visible, inspectable, reviewable, and safe for daily coding work.

## 2. Non-goals for now

This is intentionally future-facing. It should not be treated as part of the current beta/RC stabilization scope.

Non-goals:

- Do not block the current release on these items.
- Do not retrofit every existing tool UI at once.
- Do not assume browser support must be implemented without MCP; MCP-backed browser control is acceptable for v1.
- Do not rely on raw global `git diff` as the source of truth for session changes.
- Do not implement automatic code review that can modify files unless the user explicitly requests a separate fixing pass.

## 3. Design principles

### 3.1 Built-ins should be product surfaces, not just tools

A raw `Read`, `Bash`, or `Edit` invocation is useful to the model, but the user also needs a persistent, navigable surface:

- What files were read?
- What commands ran?
- What changed?
- Which changes came from this session?
- What did the reviewer find?

### 3.2 Session scope matters

For file changes and review, CodeShell should prefer a session-scoped file-change ledger over global repository diff state.

Global `git diff` answers “what is currently dirty in the worktree.” It does not answer “what did this agent/session change.” The latter is the safer default for chat-level review cards and accept/revert flows.

### 3.3 Desktop gets the richer workbench first

The desktop app should receive the full visual experience first:

- File viewer panels
- Diff cards
- Expandable command details
- Browser snapshots/screenshots
- Review summaries

TUI should remain useful but simpler:

- Paths instead of inline image rendering
- Compact diffs or links to files
- Text-first command summaries

### 3.4 Review should be cheap and common

Users should be able to ask for review without manually composing prompts. CodeShell should provide built-in actions such as:

- Review current session changes
- Review uncommitted changes
- Review last commit / last N commits

The default reviewer should be read-only.

## 4. Proposed built-ins

## 4.1 File Reader / File Viewer

### Current state

CodeShell has file-reading tools available to the assistant, and assistant responses can reference paths and line numbers.

### Future target

Add a first-class file viewing experience in desktop:

- Clickable `path:line` references from assistant messages.
- File preview panel with line numbers.
- Search within opened file.
- Recently read files list for the current session.
- “Why was this file read?” provenance when possible, linking back to the tool call or assistant turn.

### User-facing behavior

When the assistant reads `packages/core/src/tool-system/mcp-manager.ts`, the user should be able to open that file directly from the transcript, inspect the relevant line range, and understand whether it was only read or also modified.

### Implementation notes

Possible data model:

```ts
type SessionFileRead = {
  sessionId: string;
  turnId: string;
  path: string;
  range?: { start: number; end: number };
  toolCallId?: string;
  timestamp: number;
};
```

This does not need to store file contents permanently; it can store metadata and re-read from disk when the user opens the file, with clear handling for files that changed since the read.

## 4.2 Browser Workbench

### Current state

Browser control can be provided through Chrome DevTools MCP / browser-related tools in supported environments.

### Future target

Promote browser interaction into a first-class workbench panel:

- Active browser session indicator.
- Current URL / page title.
- Console messages.
- Network request summaries.
- Snapshots and screenshots in transcript.
- “Open in browser workbench” action from browser tool calls.

### User-facing behavior

For frontend debugging, the assistant should be able to:

1. Start or connect to a local dev server.
2. Open the page in the browser workbench.
3. Inspect console/network/UI state.
4. Attach screenshots or accessibility snapshots to the conversation.
5. Explain the observed issue and fix it.

The user should not need to mentally stitch together raw browser tool outputs.

### Implementation notes

V1 can remain MCP-backed. The important product change is the UI/protocol surface:

```ts
type BrowserWorkbenchEvent =
  | { type: "browser.page_opened"; sessionId: string; url: string; title?: string }
  | { type: "browser.snapshot"; sessionId: string; snapshotId: string; summary?: string }
  | { type: "browser.screenshot"; sessionId: string; path: string }
  | { type: "browser.console"; sessionId: string; level: string; message: string };
```

## 4.3 Terminal Workbench

### Current state

CodeShell has shell execution tools and existing transcript rendering for tool calls. There is also a known product direction toward Codex-style inline tool summaries with expandable details.

### Future target

Terminal execution should feel like a built-in terminal/workbench, not just scattered command outputs.

Key features:

- Inline command status summary.
- Expandable stdout/stderr/details.
- Exit code and duration.
- Working directory display.
- Long output folding.
- Command cancellation where supported.
- Grouping that respects assistant text boundaries.

### User-facing behavior

Instead of showing a large raw block for every shell command, desktop can show:

```text
Ran 3 commands
✓ bun test packages/core/src/foo.test.ts
✓ bun run build
✗ bun run lint
```

Clicking expands exact command, cwd, exit code, stdout, stderr, and permission decision details.

### Implementation notes

This should align with the existing desired behavior that tool grouping respects assistant text boundaries:

```text
assistant text
→ grouped tools/commands for that segment
assistant text
→ grouped tools/commands for that segment
```

Avoid merging all commands in a turn into one block if the assistant intentionally separated phases with text.

## 4.4 File Change Review

### Current state

CodeShell has file editing tools and patch application. Some UI can infer changed files from worktree state, but that is not enough for session-level review.

### Future target

Introduce a session-scoped file-change ledger.

The ledger should answer:

- Which files did this session create, edit, rename, or delete?
- Which tool call caused each change?
- What was the before/after content for each change?
- Has the user accepted, reverted, or ignored the change?

### User-facing behavior

At the end of a coding turn, desktop should be able to show a “Changed files” card:

```text
Changed files in this session
M packages/core/src/tool-system/mcp-manager.ts
M packages/core/src/tool-system/mcp-manager.test.ts
A docs/superpowers/specs/2026-06-04-workbench-builtins-design.md
```

Each file can expand into a diff view. Future actions may include:

- Open file
- View diff
- Copy diff
- Revert this file
- Mark reviewed
- Ask reviewer

### Implementation notes

The ledger should be populated by write-capable tools, not by polling git as the primary source.

Possible event shape:

```ts
type SessionFileChange = {
  sessionId: string;
  turnId: string;
  toolCallId: string;
  path: string;
  operation: "create" | "modify" | "delete" | "rename";
  beforeHash?: string;
  afterHash?: string;
  beforeSnapshotPath?: string;
  afterSnapshotPath?: string;
  timestamp: number;
};
```

For large files, store hashes and bounded snapshots rather than unbounded full content.

## 4.5 Code Change Review

### Current state

The user can ask for code review manually, and subagents can perform independent read-only review. There is not yet a polished built-in review action.

### Future target

Add first-class code review actions:

- Review current session changes
- Review uncommitted changes
- Review last commit
- Review branch against base

Default behavior:

- Use an independent reviewer subagent.
- Keep review read-only.
- Report findings with severity, file path, line number, and rationale.
- Do not modify files during the review pass.

### User-facing behavior

A review card should summarize:

```text
Code review completed
High: 1
Medium: 2
Low: 3
```

Each finding should include:

- Severity
- File and line
- Problem
- Why it matters
- Suggested fix

### Implementation notes

Review targets should be explicit:

```ts
type ReviewTarget =
  | { kind: "session"; sessionId: string }
  | { kind: "worktree"; includeUntracked: boolean }
  | { kind: "commit"; ref: string }
  | { kind: "range"; base: string; head: string };
```

For `kind: "session"`, use the session file-change ledger. For `kind: "worktree"`, git diff is acceptable because the user explicitly asked for worktree review.

## 5. Suggested phases

### Phase 0 — Spec and backlog only

Status: this document.

Purpose:

- Capture the direction.
- Keep it out of current release blockers.
- Give future implementation a coherent target.

### Phase 1 — Terminal and file-change visibility

Recommended first implementation slice:

- Improve command summary cards.
- Preserve assistant text boundaries in grouped tool display.
- Start recording session file-change metadata for write tools.
- Show a basic “changed files in this session” card.

Why first:

- High daily value.
- Builds trust in agent edits.
- Does not require full browser or diff editor implementation.

### Phase 2 — Diff viewer and review action

Add:

- Desktop diff viewer for session changes.
- Review current session changes action.
- Read-only reviewer subagent workflow.
- Findings card with file/line references.

Why second:

- Review depends on reliable change tracking.
- This converts the ledger into a safety feature.

### Phase 3 — File viewer polish

Add:

- Clickable path references.
- File preview panel.
- Read history per session.
- Jump-to-line support.

Why third:

- Useful, but less safety-critical than change review.

### Phase 4 — Browser workbench

Add:

- Browser session panel.
- Snapshot/screenshot cards.
- Console/network summaries.
- Frontend debugging workflow polish.

Why later:

- Browser capability is powerful but has more integration complexity.
- V1 can build on MCP-backed browser tools.

## 6. Open questions

1. Should the session file-change ledger be stored in the session directory, the project state directory, or both?
2. Should before/after snapshots be full content, bounded content, or content-addressed blobs?
3. How should revert work for edits that overlap with user changes made after the agent edit?
4. Should review findings become persistent annotations in the session, or just transcript messages?
5. Should browser workbench state be per session, per project, or global?
6. What is the minimum useful TUI experience for these built-ins?

## 7. Success criteria

This direction is successful when a user can complete a typical coding loop without leaving CodeShell:

1. Ask the assistant to inspect code.
2. See which files were read.
3. Let the assistant run commands.
4. Inspect command results without transcript noise.
5. Let the assistant edit files.
6. See exactly what changed in this session.
7. Ask for a read-only review.
8. Decide what to keep, fix, or revert.

The key product outcome is increased trust: users should feel that CodeShell makes agent work visible and reviewable, not hidden inside raw tool logs.
