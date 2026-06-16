# session

**One-line role.** Owns a session's durable on-disk identity and history: the `SessionBundle` (state + transcript), the JSONL transcript event log, the lifecycle manager (create / resume / fork / save / list), per-file edit history for undo/redo, and cross-session memory.

## 职责 / Responsibility

This module is the persistence layer for a conversation. `SessionManager` materializes each session as a directory under `~/.code-shell/sessions/<id>/` (`state.json` + `transcript.jsonl` + `file-history/`) and brokers all lifecycle transitions. `Transcript` is the append-only JSONL event log that is the source of truth — `toMessages()` derives the `Message[]` the LLM actually sees (the LLM never reads the event log directly). `FileHistory` snapshots files before edits so `/undo` and `/redo` can revert them, and `MemoryManager` persists user/dream memory entries. Its boundary stops at orchestration: it does not run turns, call models, or decide *when* to save — the engine drives those and calls in.

## 文件 / Files

| File | Purpose |
| --- | --- |
| `session-manager.ts` | `SessionManager` lifecycle (create/resume/fork/saveState/exists/readCwd/list); session-id traversal guard; `codeShellHome()`. Main entry point. |
| `transcript.ts` | `Transcript` — JSONL event log; append helpers, `toMessages()`, `repairToolResultPairs()`, `loadFromFile()`. |
| `file-history.ts` | `FileHistory` — pre-edit file snapshots, turn-tagged undo/redo material, restore. Defines `FileSnapshot` / `RedoRecord` / `CreatedMarker`. |
| `undo-target.ts` | Pure (fs-free) selectors that decide *what* to undo/redo from a snapshot list: `latestUndoTarget`, `earliestSnapshotsPerFile`, `latestTurnUndoTargets`, `latestRedoTargets`. |
| `simple-diff.ts` | Dependency-free LCS unified-diff for `/undo` previews: `diffLines`, `renderDiffPreview`. |
| `memory.ts` | `MemoryManager` — persistent user/dream memory entries as markdown; `filterByAge`, `resolveMemoryBaseDir`. |
| `*.test.ts` | Unit tests (session-manager home/origin/parent/readcwd, memory maxage, undo target/integration, simple-diff). |

## 公开接口 / Public API

Re-exported from the package root (`packages/core/src/index.ts`).

```ts
// session-manager.ts
interface SessionBundle { state: SessionState; transcript: Transcript; }
type SessionListEntry = SessionState & { preview?: string; lastActiveAt: number };

class SessionManager {
  constructor(storageDir?: string); // default: <codeShellHome()>/sessions
  create(cwd: string, model: string, provider: string,
         explicitSessionId?: string,
         parentSessionId?: string | null,
         origin?: SessionOrigin): SessionBundle;
  exists(sessionId: string): boolean;            // cheap stat probe (false on bad id)
  readCwd(sessionId: string): string | undefined; // reads ONLY state.json, not transcript
  resume(sessionId: string): SessionBundle;       // throws SessionError if missing
  saveState(state: SessionState): void;           // atomic tmp+rename
  fork(sourceSessionId: string, forkAtTurn?: number): SessionBundle;
  list(limit?: number): SessionListEntry[];        // default 20, newest-first
}
function assertSafeSessionId(id: unknown): asserts id is string;
function codeShellHome(): string; // CODE_SHELL_HOME ?? ~/.code-shell

// transcript.ts
class Transcript {
  constructor(filePath: string);
  static loadFromFile(filePath: string): Transcript; // repairs tool pairs on load
  append(type: TranscriptEventType, data: Record<string, unknown>): TranscriptEvent;
  appendMessage(role: string, content: string | ContentBlock[]): TranscriptEvent;
  appendToolUse(toolName: string, toolCallId: string, args: Record<string, unknown>): TranscriptEvent;
  appendToolResult(toolCallId: string, toolName: string, result?: string, error?: string): TranscriptEvent;
  appendTurnBoundary(): TranscriptEvent;
  appendSummary(summary: string, range: { fromTurn: number; toTurn: number; eventCount: number }): TranscriptEvent;
  toMessages(): Message[];               // derive LLM input from events
  getEvents(type?: TranscriptEventType): TranscriptEvent[];
  getFilePath(): string;
  repairToolResultPairs(): void;
  get turnNumber(): number; get eventCount(): number;
}

// file-history.ts
class FileHistory {
  constructor(sessionDir: string);       // snapshots under <sessionDir>/file-history/
  saveSnapshot(filePath: string, turnSeq?: number): FileSnapshot | null; // null if file absent
  recordCreated(filePath: string, turnSeq: number): void;
  getSnapshots(filePath: string): FileSnapshot[];
  getRedoRecords(): RedoRecord[];
  restore(snapshot: FileSnapshot): boolean;
  restoreLatest(filePath: string): boolean;
  restoreAllToEarliest(): Array<{ filePath: string; ok: boolean }>;
  undoLatestTurn(targets: FileSnapshot[]): Array<{ filePath: string; ok: boolean }>;
  redoLatestTurn(redoTargets: RedoRecord[]): Array<{ filePath: string; ok: boolean }>;
}
interface FileSnapshot { filePath; timestamp; backupPath; hash; size; turnSeq?; undone?; }
interface RedoRecord { filePath; turnSeq; backupPath; existedBefore; }

// undo-target.ts (pure selectors, fs-free)
function latestUndoTarget(snapshots: FileSnapshot[]): FileSnapshot | null;
function earliestSnapshotsPerFile(snapshots: FileSnapshot[]): FileSnapshot[];
function latestTurnUndoTargets(snapshots: FileSnapshot[]): FileSnapshot[];
function latestRedoTargets(redoRecords: RedoRecord[], snapshots: FileSnapshot[]): RedoRecord[];

// simple-diff.ts
function diffLines(from: string, to: string): DiffLine[];
function renderDiffPreview(from: string, to: string, context?: number): string;

// memory.ts
class MemoryManager {
  constructor(options?: MemoryManagerOptions | string); // string arg == { projectDir }
  save(entry: Omit<MemoryEntry, "fileName" | "scope">): string;
  getMemoryDir(): string; getScope(): MemoryScope;
}
function filterByAge(entries: MemoryEntry[], maxAgeDays?: number, now?: number): MemoryEntry[];
function resolveMemoryBaseDir(override?: string): string;
type MemoryScope = "user" | "dream";
interface MemoryEntry { name; description; type; content; fileName; scope; updatedAt?; pinned?; origin?; }
```

## 怎么用 / How to use

The engine is the primary consumer (`engine/engine.ts`). It holds one `SessionManager` and resumes-or-creates per turn:

```ts
// engine.ts: pick up an existing session or start one, then run a turn
this.sessionManager = new SessionManager(config.sessionStorageDir);

let session: SessionBundle;
if (options?.sessionId && this.sessionManager.exists(options.sessionId)) {
  session = this.sessionManager.resume(options.sessionId);
  // resumed session may know its own cwd even if the host forgot to pass one
  const cwd = options.cwd ?? this.sessionManager.readCwd(options.sessionId);
  const messages = session.transcript.toMessages();   // LLM input from the event log
  session.transcript.appendMessage("user", userMessageContent);
} else {
  session = this.sessionManager.create(cwd, model, provider, options?.sessionId);
  session.transcript.appendMessage("user", userMessageContent);
}
this.sessionManager.saveState(session.state);          // atomic persist
```

File history snapshots a file just before a tool edits it, then `/undo` uses the pure selectors to pick targets:

```ts
// engine.ts: snapshot before edit; if the file didn't exist, record a create marker
if (fileHistory.saveSnapshot(path, turnSeq) === null && turnSeq !== undefined) {
  fileHistory.recordCreated(path, turnSeq);
}

// a /undo command (TUI or desktop host): preview then revert the latest turn
const targets = latestTurnUndoTargets(fileHistory.getSnapshots(somePath)); // or full list
const preview = renderDiffPreview(currentOnDisk, fs.readFileSync(targets[0].backupPath, "utf8"));
const results = fileHistory.undoLatestTurn(targets);
```

## 注意 / Gotchas

- **Every public ID goes through `assertSafeSessionId` before a path `join`.** `create(explicitSessionId)`, `resume`, `saveState(state.sessionId)`, `fork`, `exists`, `readCwd` all validate (allow-list `[A-Za-z0-9_.-]`, max 128, no `..`/separators) — IDs come from protocol clients and on-disk state and could be traversal-shaped. `exists`/`readCwd` swallow a bad id as "not present" rather than throwing.
- **`resume` throws, `exists`/`readCwd` don't.** Use `exists()` (one cheap stat) to branch between resume and create-with-explicit-id; don't catch `SessionError` to probe.
- **The transcript event log is the source of truth, not chat history.** The LLM only ever sees `toMessages()`-derived `Message[]`; `turn_boundary`, `session_meta`, `file_history`, etc. are intentionally excluded. Don't bypass it to "send raw events."
- **`loadFromFile` auto-runs `repairToolResultPairs()`** — orphaned `tool_result`s are dropped and dangling `tool_use`s get synthetic error results, so a resumed transcript is always API-valid. Malformed JSONL lines are silently skipped.
- **`Transcript.flush` and `MemoryManager`/`FileHistory` IO are best-effort/soft.** Transcript flush failures are swallowed (events stay in memory); the preview tail-reader and `readCwd` return `undefined` on any IO error. Memory deletes are SOFT (moved to `memory-trash/`), not removed.
- **`saveState` is atomic (tmp + rename); `Transcript.append` is a plain `appendFileSync`.** State writes survive concurrent writers; transcript appends do not lock.
- **`undo-target.ts` and `simple-diff.ts` are deliberately fs-free and pure** so the "what to undo" decision is unit-testable and shared across hosts. Keep them that way — read files in the caller, pass content/snapshot lists in.
- **`turnSeq`-tagged snapshots vs. legacy.** Undo is turn-level (`one user message = one turn`). Snapshots written before the feature have no `turnSeq`, share the `undefined` (smallest) bucket, and degrade to whole-session behavior. `undone` snapshots/markers are kept on disk (not deleted) so redo has material — selectors skip them.
- **`CODE_SHELL_HOME` overrides `~/.code-shell`** for both sessions (`codeShellHome()`) and memory (`resolveMemoryBaseDir`). Tests set it to a temp dir to avoid polluting the real home — when writing tests, isolate `HOME`/`CODE_SHELL_HOME` or you'll leave junk sessions in the user's sidebar.
- **`MemoryManager`'s constructor accepts a legacy `string` arg** meaning `{ projectDir }`. Prefer the options object.
- This is a TS source module compiled to `dist`; hosts/TUI import the built output, so **rebuild core** after changes here before the desktop/tui picks them up.
