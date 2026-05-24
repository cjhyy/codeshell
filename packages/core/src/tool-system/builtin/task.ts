/**
 * Built-in task management — a single TodoWrite tool, cc-style.
 *
 * Design (2026-05-24 simplification, replacing the legacy 6-tool API):
 *
 *   - One tool, one shape: TodoWrite({ todos: [{content, status, activeForm}] }).
 *     Each call replaces the entire snapshot — no per-item update API.
 *   - The transcript IS the task store. The LLM reads its own last
 *     TodoWrite tool_use input to know "where am I in the list".
 *   - No module singleton. No in-memory map. No file persistence.
 *     Resume hydrates by scanning the loaded transcript for the most
 *     recent TodoWrite tool_use.
 *   - Sub-agent isolation: when called from a spawned sub-agent, the
 *     emitted task_update event carries the sub-agent's id so the UI
 *     can keep the main and sub-agent todo lists separate (cc bucketing
 *     by `context.agentId ?? sessionId`).
 *
 * Why no TaskManager:
 *   The legacy TaskCreate/Update/Stop/Get/Output/List sextet stored
 *   state behind a module-level TaskManager singleton. Desktop spawns
 *   one worker process per agent/run, so the singleton vanished after
 *   each run — the next run's `TaskList` returned "No tasks" even
 *   though the transcript still had the full plan. Replacing the
 *   sextet with one snapshot tool whose output lives in the transcript
 *   makes the worker's lifecycle irrelevant: every restart re-reads
 *   the snapshot for free.
 */

import type { ToolDefinition, StreamCallback, TaskInfo, TranscriptEvent } from "../../types.js";
import type { ToolContext } from "../context.js";

// ─── Public types ────────────────────────────────────────────────

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TaskStatus;
  /** Present-continuous form shown while in_progress (e.g. "Fixing auth"). */
  activeForm: string;
}

// Legacy alias so SDK consumers that imported the old `Task` type keep
// compiling. New code should use TaskInfo from ../../types.
export type Task = TaskInfo;

// ─── Tool definition ─────────────────────────────────────────────

export const todoWriteToolDef: ToolDefinition = {
  name: "TodoWrite",
  description:
    "Manage the session todo list. Pass the COMPLETE list each call — there's no per-item update API, you rewrite the entire snapshot. " +
    "Use proactively for tasks with 3+ steps. Exactly one item should be in_progress at a time. " +
    "Always provide both `content` (imperative) and `activeForm` (present continuous) so the UI can show what's happening right now.",
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The updated todo list. Replaces any previous list.",
        items: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "Imperative form, e.g. 'Run tests'.",
            },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
            },
            activeForm: {
              type: "string",
              description: "Present continuous form, e.g. 'Running tests'.",
            },
          },
          required: ["content", "status", "activeForm"],
        },
      },
    },
    required: ["todos"],
  },
};

// ─── Tool implementation ─────────────────────────────────────────

export async function todoWriteTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const raw = args.todos;
  if (!Array.isArray(raw)) {
    return "Error: `todos` must be an array.";
  }

  const todos = parseTodos(raw);

  // cc's "everything done → clear the panel" behaviour: when the last
  // item flips to completed, drop the list so the UI doesn't keep
  // showing a stale "all done" panel. The model can still see its
  // history in the transcript if it needs to reference what was done.
  const allDone = todos.length > 0 && todos.every((t) => t.status === "completed");
  const effective = allDone ? [] : todos;

  emitTaskUpdate(ctx, toTaskInfos(effective));

  // Short, cc-style confirmation. The model already has the new snapshot
  // in its own input — no point echoing the full list back here.
  return "Todos have been updated. Continue to use TodoWrite to track progress.";
}

function parseTodos(raw: unknown[]): TodoItem[] {
  const out: TodoItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const obj = r as Record<string, unknown>;
    if (typeof obj.content !== "string") continue;
    const status = obj.status;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") continue;
    const activeForm = typeof obj.activeForm === "string" ? obj.activeForm : obj.content;
    out.push({ content: obj.content, status, activeForm });
  }
  return out;
}

function toTaskInfos(todos: TodoItem[]): TaskInfo[] {
  // Position-based ids — stable React keys for the UI; LLMs never see them.
  return todos.map((t, i) => ({
    id: String(i + 1),
    subject: t.content,
    activeForm: t.activeForm,
    status: t.status,
  }));
}

function emitTaskUpdate(ctx: ToolContext | undefined, tasks: TaskInfo[]): void {
  const cb = ctx?.streamCallback as StreamCallback | undefined;
  cb?.({ type: "task_update", tasks });
}

// ─── Transcript replay (used by Engine on session resume) ────────

/**
 * Pull the latest todo snapshot from a transcript's event stream.
 *
 * Walks newest-first looking for a `tool_use` event whose toolName is
 * TodoWrite — its args carry the canonical snapshot. Returns null if
 * no TodoWrite call exists in the transcript (e.g. fresh session, or
 * a session where the agent never used the tool).
 */
export function readLastTodoSnapshot(events: TranscriptEvent[]): TaskInfo[] | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== "tool_use") continue;
    const d = e.data ?? {};
    if (d.toolName !== "TodoWrite") continue;
    const args = (d.args ?? {}) as Record<string, unknown>;
    const todos = args.todos;
    if (!Array.isArray(todos)) continue;
    const parsed = parseTodos(todos);
    // Honour the same "all done → clear" rule as the live tool, so a
    // session that finished with everything completed restores to an
    // empty pinned panel.
    const allDone = parsed.length > 0 && parsed.every((t) => t.status === "completed");
    return allDone ? [] : toTaskInfos(parsed);
  }
  return null;
}
