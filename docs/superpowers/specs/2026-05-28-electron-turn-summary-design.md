# Electron Turn Summary — Design Spec

**Date**: 2026-05-28
**Status**: Draft
**Owner**: maki
**Branch**: `feat/electron-turn-summary` (cut from `main`)

## Background

The Electron renderer chat stream has three rough edges that diverge from Codex/Claude.ai polish:

1. **Stray `…` placeholder rows** appear above tool bubbles whenever a turn opens with tool calls before any assistant text — `stream_request_start` creates an empty AssistantMessage that gets rendered as `<pre>…</pre>` until `text_delta` lands.
2. **No per-turn "files changed" summary**. Codex appends a folded card at the end of each turn ("已编辑 13 个文件 +1,328 -98") with per-file rows. We have nothing equivalent — the user has to scroll a long tool-bubble run to know what changed.
3. **Tool cards stay expanded forever**. ToolCardShell defaults to collapsed, but once the user expands a card during streaming, it stays open across turns. Past-turn details bury the current conversation.

All three are renderer-only fixes. No engine/core changes.

## Goals

- Hide empty streaming assistant messages until the first `text_delta` arrives.
- After each `turn_complete`, append a single Codex-style "files changed" card summarizing this turn's `Edit` / `Write` / `NotebookEdit` calls (including those made by subagents).
- After each `turn_complete`, force-collapse every `ToolCard` and `ToolGroupCard` so prior detail folds back out of the way.

## Non-Goals

- Source-of-truth file diffs. We estimate `+X -Y` from tool args (line counts of `new_string` vs `old_string` etc.), not `git diff`. Approximate is fine — matches Codex behavior.
- Per-turn diffing across the whole repo or external files modified by Bash. Out of scope.
- Persisting fold state across app reloads, or a global "expand/collapse all" control.
- Touching the engine, core, or any IPC. Pure renderer.

## Architecture

### Data model additions (`packages/desktop/src/renderer/types.ts`)

```ts
export interface FileEditEntry {
  path: string;
  added: number;
  removed: number;
  count: number;  // number of tool calls that touched this path
}

export interface FilesChangedSummaryMessage {
  kind: "files_changed";
  id: string;
  files: FileEditEntry[];
  totalAdded: number;
  totalRemoved: number;
}
```

Add to the `Message` union. `MessagesReducerState` gains `turnEpoch: number`, initialized to `0`.

### Aggregator (`packages/desktop/src/renderer/messages/fileChangeAggregator.ts`, new)

Pure function:

```ts
export function aggregateFileChanges(messages: Message[]): FileEditEntry[] | null
```

Scans from the last `kind === "user"` message to the end. Collects every `ToolMessage` whose `toolName` (lowercased) is in `{"edit", "multiedit", "applypatch", "apply_patch", "write", "filewrite", "notebookedit", "notebook_edit"}` and `status === "succeeded"`. Also walks `AgentMessage.toolCalls[]` to include subagent edits.

Line-count estimation, per parsed `args` JSON:
- `Edit` / `applyPatch`: `added = countLines(new_string ?? new_source)`, `removed = countLines(old_string ?? old_source)`.
- `Write`: `added = countLines(content)`, `removed = 0`.
- `NotebookEdit`: same as Edit (`new_source`, `old_source`).

Where `countLines(s)` is `s ? s.split("\n").length : 0`.

Merge by path. Returns `null` if no qualifying tools were found (so the reducer skips appending a card).

### Reducer change (`applyStreamEvent`, `case "turn_complete"`)

After the existing agent-textBuffer flush and assistant/thinking finalization:

1. Compute `entries = aggregateFileChanges(messages)` on the *finalized* messages list.
2. Remove any prior `kind === "files_changed"` after the last user message (handles the multi-`turn_complete` case where engine reopened the loop).
3. If `entries` is non-null, append a `FilesChangedSummaryMessage` with totals.
4. Set `turnEpoch: state.turnEpoch + 1`.

### Forced collapse (`turnEpoch` prop)

`MessageStream` reads `turnEpoch` from the reducer state and passes it to every `ToolCard` and `ToolGroupCard`. Each component:

```tsx
const [open, setOpen] = useState(false);
useEffect(() => {
  if (turnEpoch !== undefined) setOpen(false);
}, [turnEpoch]);
```

No `key` re-mounting — preserves the rest of the local component tree. Cards already-closed get a harmless no-op `setOpen(false)`.

`FilesChangedCard` is created at `turn_complete` time and starts collapsed, so it doesn't need the epoch hook.

### UI: `FilesChangedCard` (`packages/desktop/src/renderer/messages/FilesChangedCard.tsx`, new)

Mirrors `ToolGroupCard`'s shape. Header (always visible):

```
▶  已编辑 {N} 个文件     +{totalAdded} -{totalRemoved}
```

Right-side totals: green `+X`, red `-Y`, matching `tool-card-row-val added`/`removed` colors from `FileToolCard`.

Body (expanded):

```
path/to/file.ts                 +98  -0
packages/desktop/src/main/...   +61  -2
packages/desktop/src/main/i...  +40  -1
─────────────────────────────────────
再显示 10 个文件 ▾
```

First 3 files shown by default when expanded; "再显示 N 个文件" reveals the rest via local state. Path truncated with `truncate(p, 70)` (reuse `tool-cards/utils.ts`).

Default state: collapsed. ChevronRight/ChevronDown icons match `ToolGroupCard`.

### Empty-message fix (`MessageStream.tsx`, `case "assistant"`)

```tsx
case "assistant":
  if (!m.done && m.text === "") return null;
  return (/* existing JSX unchanged */);
```

## Component boundaries

```
┌─────────────────────────────────────────────────────────────┐
│ applyStreamEvent (types.ts)                                 │
│  - turn_complete:                                           │
│      flush agent buffers + done flags  (existing)           │
│      aggregateFileChanges → maybe append files_changed (new)│
│      turnEpoch++                                            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ MessageStream                                               │
│  - reads turnEpoch from reducer state                       │
│  - passes turnEpoch into ToolCard, ToolGroupCard            │
│  - new case "files_changed" → <FilesChangedCard/>           │
│  - case "assistant" guard: return null when empty+streaming │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────┐  ┌──────────────────┐  ┌───────────────┐
│ ToolCardShell    │  │ ToolGroupCard    │  │ FilesChanged- │
│ effect: epoch→   │  │ effect: epoch→   │  │ Card          │
│  setOpen(false)  │  │  setOpen(false)  │  │ (always       │
└──────────────────┘  └──────────────────┘  │  initial-     │
                                            │  collapsed)   │
                                            └───────────────┘
                              │
                              ▼
                ┌─────────────────────────────┐
                │ aggregateFileChanges (pure) │
                │ — unit tested standalone    │
                └─────────────────────────────┘
```

## Error handling

- Malformed tool `args` JSON → swallow, count as 0 lines.
- Missing/non-string `file_path` or `path` → skip that tool call entirely.
- Empty `entries` → don't append the card (no "已编辑 0 个文件" stub).
- Cancelled / failed tool calls → not counted (status check).

## Testing

- **Unit** — `fileChangeAggregator.test.ts`:
  - Edit + Write + NotebookEdit aggregation by path
  - Same-path multiple edits → one entry with summed +/-
  - Subagent toolCalls included
  - Failed/cancelled tools excluded
  - Malformed JSON args don't crash

- **Reducer** — extend `types` reducer tests (or sibling test) to verify:
  - `turn_complete` inserts `files_changed` when appropriate, skips when not
  - Multiple `turn_complete` events in one user-turn replace rather than duplicate
  - `turnEpoch` increments

- **UI verification** (manual via /verify, electron app):
  1. Start a new conversation. Confirm no stray `…` appears.
  2. Ask assistant to edit a few files. Confirm a folded "已编辑 N 个文件 +X -Y" card appears at the end of the turn. Expand it; verify per-file rows.
  3. During streaming, manually expand a tool card. After `turn_complete`, it should be collapsed.
  4. Subagent edits should be counted in the parent turn's summary card.

## Files touched

- `packages/desktop/src/renderer/types.ts` — `FilesChangedSummaryMessage`, `turnEpoch`, `turn_complete` extension
- `packages/desktop/src/renderer/messages/fileChangeAggregator.ts` — **new**
- `packages/desktop/src/renderer/messages/FilesChangedCard.tsx` — **new**
- `packages/desktop/src/renderer/MessageStream.tsx` — empty-message guard, `files_changed` route, `turnEpoch` prop wiring
- `packages/desktop/src/renderer/tool-cards/ToolCardShell.tsx` — `turnEpoch` prop + effect
- `packages/desktop/src/renderer/tool-cards/index.tsx` — pass-through `turnEpoch`
- `packages/desktop/src/renderer/messages/ToolGroupCard.tsx` — `turnEpoch` prop + effect; pass to inner ToolCard
- `packages/desktop/src/renderer/styles/*.css` — minimal additions for FilesChangedCard layout (reuse existing `tool-group-*` styles where possible)
- `packages/desktop/src/renderer/App.tsx` (or wherever `state.turnEpoch` plumbs into `MessageStream`) — pass prop

## Out of scope / followups

- Bash-induced file changes (not tracked).
- `git diff` ground-truth +/- (estimation good enough for now).
- Persisting collapse state across reload.
- Showing per-file diff snippets inline in the card (today's expanded view is path + counts only).
