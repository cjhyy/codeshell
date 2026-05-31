# Automation Run → Sidebar Attribution — Design

**Date**: 2026-05-31
**Status**: Approved design, pending spec review
**Related**: [[project-automation-plan]], [[project-runlock-esm-bug]]

## Problem

Automation (cron) runs execute in core and persist to disk
(`~/.code-shell/runs/<runId>/` + `~/.code-shell/sessions/<sessionId>/transcript.jsonl`),
often while the desktop app is closed (headless / resident service). The desktop
sidebar groups conversations by project, but reads **only** the renderer's
`localStorage`. Automation runs never touch localStorage, so they are invisible
in the sidebar — there is no way to "click into the project and see what the
automation ran."

We want an automation run to appear as a **normal session** under the project
matching its `cwd`, with the full transcript viewable on click, visually marked
as automation-sourced, and deletable together with its on-disk data.

## Key facts established during brainstorming

- **Disk is where everything lives.** *Every* session's transcript is written to
  disk by the engine `Transcript` class (`core/src/session/transcript.ts`, an
  `appendFileSync` per event) at `~/.code-shell/sessions/<sessionId>/transcript.jsonl`.
  Manual chats and automation runs alike. localStorage is a renderer-only
  projection populated only when a session streams live while the app is open.
- **A run record** lives at `~/.code-shell/runs/<runId>/run.json` (snapshot) with
  fields: `runId`, `objective`, `cwd`, `sessionId` (bound after first turn),
  `status`, timestamps, `metadata`. Automation runs carry
  `metadata.source === "automation"` plus `cronJobId` / `cronJobName`
  (`core/src/automation/runner.ts`).
- **Sidebar data model** (`desktop/src/renderer/transcripts.ts`): projects
  (`repos.ts`, keyed by repo `id`, each with a `path`), `SessionIndex` per repo
  (`codeshell.sessionIndex.<repoKey>`), and `MessagesReducerState` per session
  (`codeshell.transcript.<repoKey>.<sessionId>`). `SessionSummary` already has an
  optional `engineSessionId`.
- **No JSONL→renderer converter exists.** The renderer only consumes live
  `StreamEvent`s via `applyStreamEvent()` (`desktop/src/renderer/types.ts`).
- **`repoId` is a renderer-only concept.** Core has a `no-host-deps` guard;
  storing `repoId` on a core cron job would leak a UI concern into core.

## Decisions (locked with user)

| Topic | Decision |
|---|---|
| Final form | Run appears as a **normal session** (full transcript), not a separate pane. |
| Storage model | Keep localStorage as the sidebar's sole data source. **Import** runs disk→localStorage. Do NOT re-architect the sidebar to read disk. |
| Sync timing | **Both**: startup backfill from disk + live push while app is open. Deduped. |
| Attribution | Reverse-match run `cwd` → `repo.path` (normalized). Core stays ignorant of `repoId`. |
| Unknown cwd | Should never happen (jobs are created within a project). If it does: auto-create a project from the cwd (safety net). |
| Transcript source | Startup full conversion: engine JSONL → `MessagesReducerState`, written into localStorage. |
| Visual marker | `source: "automation"` on `SessionSummary`; sidebar shows a small icon/tag. |
| Backfill scope | Limit to most-recent **N=50** automation runs per project. |
| Delete | Unified: removes localStorage entry **and** on-disk session dir **and** run dir. |
| Idempotency key | `engineSessionId` (the run's `sessionId`). |

## Architecture

```
┌─────────────────────── disk (data layer, source of truth) ───────────────────┐
│  ~/.code-shell/runs/<runId>/run.json   (cwd, sessionId, status, metadata)     │
│  ~/.code-shell/sessions/<sessionId>/transcript.jsonl  (TranscriptEvent[])     │
└───────────────────────────────────────────────────────────────────────────────┘
        │  runs:list / runs:get                │  sessions:transcript (new)
        │  (main process, runs-service)        │  (main process, sessions-service)
        ▼                                       ▼
┌──────────────────────────── main process (Electron) ──────────────────────────┐
│  runs-service.ts   — already lists/gets runs                                  │
│  sessions-service.ts — NEW: parse transcript.jsonl → fold items; del dir      │
│  runs-service.ts   — NEW: runs:delete (remove run dir)                        │
└───────────────────────────────────────────────────────────────────────────────┘
        │  window.codeshell.* (preload bridge)
        ▼
┌──────────────────────────── renderer (App.tsx) ──────────────────────────────┐
│  1. Backfill on startup / project activate                                    │
│  2. Live push subscription (run completed while open)                         │
│  3. Attribution (cwd→repo) + dedup (engineSessionId)                          │
│  4. Import as SessionSummary{source:"automation"} + MessagesReducerState      │
│  5. Unified delete                                                            │
└───────────────────────────────────────────────────────────────────────────────┘
```

### Component 1 — Transcript reader + converter (main process)

New IPC channel `sessions:transcript` → `getSessionTranscript(sessionId)` in
`sessions-service.ts`. Reads `~/.code-shell/sessions/<sessionId>/transcript.jsonl`,
parses `TranscriptEvent[]`, and **synthesizes `StreamEvent`s** from them so the
renderer can reuse `applyStreamEvent()` rather than maintaining a second
message-mapping. Mapping:

| TranscriptEvent.type | Synthesized StreamEvent(s) |
|---|---|
| `session_meta` | `session_started` (carries sessionId, cwd) |
| `message` role=user | (rendered as user message — see note) |
| `message` role=assistant | `stream_request_start` + `text_delta`(full text) + `assistant_message`(done) |
| `tool_use` | `tool_use_start` (toolName, toolCallId, args) |
| `tool_result` | `tool_result` (toolCallId, result/error) |
| `turn_boundary` | `turn_complete` |
| `summary` | `context_compact` (ContextBoundaryMessage) |
| `error` | `error` |

**Decision: the reducer stays single-sourced in the renderer.** Main does a pure
parse — it reads the JSONL and returns an ordered list of **fold items**, never
a `MessagesReducerState`. A fold item is a tagged union:
`{ kind: "stream"; event: StreamEvent }` or `{ kind: "user"; text: string }`
(emitted for `message` role=user, since `applyStreamEvent` has no user-message
event). Items are ordered by the source events' timestamps.

The renderer folds the list: `kind: "stream"` items go through the existing
`applyStreamEvent()`, `kind: "user"` items through the existing
`appendUserMessage()`, accumulating into a `MessagesReducerState`. This reuses
the live rendering logic verbatim and keeps the main/renderer boundary clean
(main: JSONL → fold items; renderer: fold items → state).

### Component 2 — Attribution + dedup (renderer)

On startup and on project activation:

1. `const runs = await window.codeshell.listRuns()` → filter
   `metadata.source === "automation"` and `status` is terminal
   (`completed`/`failed`/`cancelled`) and has a non-null `sessionId`.
2. For each run, normalize `run.cwd` and find the repo whose normalized `path`
   matches (see Path normalization). If none, auto-create a repo from the cwd.
3. Sort by `finishedAt` desc, take first **50 per repo**.
4. Dedup: skip any run whose `sessionId` already appears as an
   `engineSessionId` in that repo's `SessionIndex`.
5. For each remaining run: fetch transcript, fold to `MessagesReducerState`,
   write `codeshell.transcript.<repoKey>.<sessionId>` and add a `SessionSummary`
   `{ id: <derived>, engineSessionId: run.sessionId, source: "automation",
   title: run.cronJobName ?? run.objective-truncated, createdAt: run.createdAt,
   updatedAt: run.finishedAt }` to the repo's `SessionIndex`.

### Component 3 — Live push (renderer)

When the app is open and an automation run finishes, the renderer should import
it without a restart. Reuse the existing run-event/notification path: on a
run-completed notification (`agentNotificationBus → Notification`, already wired
in P3), trigger the same single-run import used by backfill, keyed by
`sessionId` so it's idempotent against the backfill that will also see it later.

### Component 4 — Unified delete (renderer + main)

Deleting an automation session from the sidebar must remove **three** things:

1. localStorage: `SessionSummary` from `SessionIndex` + the `transcript.*` key
   (existing renderer logic).
2. Disk session dir: `sessions:delete` must be **fixed** — today it only unlinks
   a flat `<id>.jsonl`/`<id>.json` file, but the engine writes a
   `<sessionId>/transcript.jsonl` **directory**. Extend `deleteSession` to
   `rm -rf` the `<sessionId>/` directory (and keep the legacy flat-file unlink
   for backward compat).
3. Run dir: new `runs:delete` → remove `~/.code-shell/runs/<runId>/`. The
   renderer maps `engineSessionId` → `runId` (carried on the imported
   `SessionSummary`, add a `runId?` field) to know which run dir to delete.

Manual sessions keep their current delete behavior; only sessions with
`source: "automation"` invoke the extended delete that also clears the run dir.
The `sessions:delete` directory fix applies to all sessions (it's a latent bug).

## Path normalization

Match `run.cwd` to `repo.path` after: `path.resolve`, strip trailing slash,
and on darwin/win32 compare case-insensitively (case-sensitive on linux).
This is a small shared helper used by attribution.

## Data model changes

- `SessionSummary` (renderer `transcripts.ts`): add
  `source?: "automation"` and `runId?: string`. Existing `engineSessionId`
  reused as idempotency key.
- No core type changes. No cron-job schema changes. (`repoId` deliberately NOT
  added to the core job.)

## Error handling

- Run with null `sessionId` (never started / crashed pre-session): skip import,
  it has no transcript.
- Corrupt / missing `transcript.jsonl`: import the `SessionSummary` with an empty
  transcript and a `SystemMessage` noting the transcript was unavailable; do not
  throw (one bad run must not block the others).
- cwd matches no repo: auto-create repo (logged), then attribute.
- Delete partial failure: attempt all three removals; collect errors; surface a
  single warning but still remove what succeeded (localStorage first so the UI
  reflects the user's intent even if a disk unlink races).

## Testing

- **Converter (main, unit)**: feed crafted `TranscriptEvent[]` covering each type
  (incl. tool_use/result pairing, multi-turn, summary, error) → assert the
  synthesized `StreamEvent[]` shape. Characterize against a real recorded
  transcript fixture.
- **Fold (renderer, unit)**: StreamEvent[] + user messages → assert resulting
  `MessagesReducerState.messages` match a manual session of the same content.
- **Attribution (renderer, unit)**: cwd/path normalization matrix (trailing
  slash, case, symlink-resolved, no-match→auto-create).
- **Dedup (renderer, unit)**: same run seen by backfill then live push imports
  once; pre-existing manual session with same engineSessionId not duplicated.
- **Delete (main, unit)**: `deleteSession` removes a `<id>/` directory (new) and
  still removes legacy flat files; `runs:delete` removes the run dir; missing
  paths are no-ops not throws.
- **Backfill cap**: 60 automation runs in one repo → only 50 most-recent
  imported.

## Out of scope (YAGNI)

- "Load more / load older runs" pagination beyond the N=50 cap — note the import
  function takes a limit so a future affordance is cheap, but no UI now.
- Re-architecting the sidebar to read directly from disk (explicitly rejected).
- Storing `repoId` on core cron jobs (explicitly rejected).
- Live-streaming an *in-progress* automation run into the sidebar tab; we import
  on completion only.
