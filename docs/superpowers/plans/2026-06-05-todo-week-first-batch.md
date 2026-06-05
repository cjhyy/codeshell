# TODO-week First Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the first recommended TODO-week batch: hide unavailable settings entries, prevent removed projects from auto-resurrecting, and render generated image results inline in desktop.

**Architecture:** Keep changes local to existing renderer persistence and rendering paths. Use a small repo tombstone API in `repos.ts`, gate automatic repo creation through that API, hide unavailable settings UI at render time, and augment desktop rendering of PNG tool-result paths without changing TUI behavior.

**Tech Stack:** Bun, TypeScript, React/Electron renderer, localStorage persistence, existing Bun tests.

---

## File Map

- `packages/desktop/src/renderer/repos.ts`: repo list persistence plus removed-path tombstone helpers.
- `packages/desktop/src/renderer/App.tsx`: mark removed repo paths, clear tombstones on manual add, and skip automatic `createRepoForCwd` for removed paths.
- `packages/desktop/src/renderer/settings/*`: hide browser/computer-control settings entries if they are static UI.
- `packages/desktop/src/renderer/Markdown.tsx` or chat/tool rendering files: render PNG paths from tool results as desktop image previews while preserving text.
- Tests near existing renderer tests: cover tombstone helpers, auto-create skip behavior, hidden settings labels, and PNG result preview.

## Tasks

### Task 1: Removed project tombstones

- [ ] Add localStorage helpers in `repos.ts`: `loadRemovedRepoPaths`, `isRepoPathRemoved`, `markRepoPathRemoved`, `unmarkRepoPathRemoved`.
- [ ] Add unit tests for marking, duplicate prevention, clearing, and invalid storage fallback.
- [ ] Update `handleRemoveRepo` in `App.tsx` to mark the removed repo path.
- [ ] Update `handleAddRepo` to unmark the selected path before adding/selecting it.
- [ ] Update every automatic `createRepoForCwd` callback in `App.tsx` to return `null`/skip when cwd is removed, adapting helper signatures if needed.
- [ ] Add focused tests for disk/automation planning skip if an existing pure function supports it; otherwise cover helper behavior and avoid broad UI tests.

### Task 2: Hide unavailable settings entries

- [ ] Locate browser/computer-control labels or capability keys in settings renderer.
- [ ] Hide the static rows or filter unsupported capability descriptors at render time.
- [ ] Add/adjust a renderer test if there is an existing test harness; otherwise keep change minimal and verify by grep/build.

### Task 3: Generated image preview

- [ ] Locate desktop Markdown/tool-result rendering path for text containing local PNG paths.
- [ ] Add a small extractor for `.png` paths under generated image output or local absolute paths.
- [ ] Render preview using the existing image/link component/path handling and keep original text visible.
- [ ] Ensure TUI behavior remains path-only by limiting change to desktop renderer.
- [ ] Add a focused unit/component test if existing renderer tests support it.

### Task 4: Verification and TODO update

- [ ] Run targeted Bun tests for changed modules.
- [ ] Run typecheck only if targeted tests are insufficient; note known pre-existing typecheck noise.
- [ ] Mark completed TODO-week items (#8, #12, #13) if verification passes, or add precise follow-up notes if partially done.
