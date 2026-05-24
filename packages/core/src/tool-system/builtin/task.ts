/**
 * Built-in task management: a single `TodoWrite` tool.
 *
 * Design (after the 2026-05-24 simplification):
 *   - No in-memory TaskManager. The transcript IS the task store.
 *   - Each `TodoWrite` call passes the ENTIRE todo list as a snapshot.
 *     The previous snapshot is overwritten — there is no per-item
 *     update API.
 *   - The tool's return value is the formatted list, so a future
 *     turn (even one in a fresh worker process) reads the last
 *     snapshot straight from transcript.jsonl.
 *   - One `task_update` stream event is emitted on each call so the
 *     UI's pinned task panel stays in sync.
 *
 * Why a snapshot and not deltas:
 *   The previous TaskCreate/TaskUpdate API stored a sequence of
 *   incremental ops behind an in-memory map. When the worker process
 *   exited (the desktop bridge spawns one per run), the map was lost
 *   and the next run's TaskList returned "No tasks". A snapshot tool
 *   doesn't need a runtime store at all: the LLM reads its own last
 *   tool_result and rewrites it.
 *
 * Legacy IDs:
 *   The desktop renderer still listens for `task_update` events and
 *   the TaskInfo wire shape from packages/desktop/.../types.ts keeps
 *   the existing { id, subject, activeForm?, status } fields. We
 *   manufacture an id per position (`"1"`, `"2"`, ...) so the UI
 *   can use stable React keys; LLMs never see these ids.
 */

import type { ToolDefinition, StreamCallback, TaskInfo } from "../../types.js";
import type { ToolContext } from "../context.js";

// ─── Public types ────────────────────────────────────────────────

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TaskStatus;
  /** Present-continuous form shown in the UI when status is in_progress. */
  activeForm?: string;
}

// Re-exported for legacy importers that pulled `Task` from this module.
export type Task = TaskInfo;

// ─── Tool definition ─────────────────────────────────────────────

export const todoWriteToolDef: ToolDefinition = {
  name: "TodoWrite",
  description:
    "Plan and track multi-step work. Pass the COMPLETE todo list each time you call this — there is no per-item update, you rewrite the whole snapshot. Use proactively for tasks with 3+ steps so the user can see your progress. " +
    "Status semantics: " +
    "`pending` = not yet started; " +
    "`in_progress` = actively working on this now (exactly one item should be in_progress at a time); " +
    "`completed` = fully done. " +
    "Always include an `activeForm` (present-continuous) for in_progress items so the UI can show what is happening right now. " +
    "After each meaningful step, call TodoWrite again with the updated list — the user relies on the running snapshot to see progress.",
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The complete todo list. Replaces any previous list.",
        items: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "Imperative-form task title (e.g. 'Fix authentication bug').",
            },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
              description: "Current status. At most one item should be in_progress.",
            },
            activeForm: {
              type: "string",
              description: "Present-continuous label shown while in_progress (e.g. 'Fixing authentication bug').",
            },
          },
          required: ["content", "status"],
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

  const todos: TodoItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const obj = r as Record<string, unknown>;
    if (typeof obj.content !== "string") continue;
    const status = obj.status;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") continue;
    const item: TodoItem = { content: obj.content, status };
    if (typeof obj.activeForm === "string") item.activeForm = obj.activeForm;
    todos.push(item);
  }

  // Emit one task_update so the UI's pinned panel refreshes. id is
  // position-based so React keys stay stable across rewrites.
  const tasks: TaskInfo[] = todos.map((t, i) => ({
    id: String(i + 1),
    subject: t.content,
    activeForm: t.activeForm,
    status: t.status,
  }));
  emitTaskUpdate(ctx, tasks);

  return formatSnapshot(todos);
}

/**
 * Pull the latest todo snapshot out of a transcript event stream.
 * Used by the engine on session resume to replay one task_update so
 * the UI re-hydrates without needing the LLM to re-run TodoWrite.
 *
 * Walks events newest-first looking for a tool_result whose toolName
 * is TodoWrite — its args carry the snapshot directly. Also tolerates
 * legacy TaskCreate/TaskUpdate runs by scanning their tool_use events
 * and rebuilding a best-effort list (legacy sessions stay usable).
 */
export function readLastTodoSnapshot(
  events: Array<{ type: string; data: Record<string, unknown> }>,
): TaskInfo[] | null {
  // Newer schema: a single TodoWrite tool_use carries the canonical list.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== "tool_use") continue;
    const d = e.data ?? {};
    if (d.toolName !== "TodoWrite") continue;
    const args = (d.args ?? {}) as Record<string, unknown>;
    const todos = args.todos;
    if (!Array.isArray(todos)) continue;
    return todos
      .filter((t) => t && typeof t === "object")
      .map((t, idx) => {
        const obj = t as Record<string, unknown>;
        return {
          id: String(idx + 1),
          subject: typeof obj.content === "string" ? obj.content : "",
          activeForm: typeof obj.activeForm === "string" ? obj.activeForm : undefined,
          status:
            obj.status === "in_progress" || obj.status === "completed" || obj.status === "pending"
              ? (obj.status as TaskStatus)
              : "pending",
        };
      });
  }

  // Legacy schema: rebuild from a sequence of TaskCreate / TaskUpdate /
  // TaskStop tool_use events. Best-effort — old sessions won't be perfect
  // but will at least show the create order with last-known status.
  const tasks = new Map<string, TaskInfo>();
  let nextId = 1;
  for (const e of events) {
    if (e.type !== "tool_use") continue;
    const d = e.data ?? {};
    const toolName = d.toolName as string | undefined;
    const args = (d.args ?? {}) as Record<string, unknown>;
    if (toolName === "TaskCreate") {
      const id = String(nextId++);
      tasks.set(id, {
        id,
        subject: typeof args.subject === "string" ? args.subject : "",
        activeForm: typeof args.activeForm === "string" ? args.activeForm : undefined,
        status: "pending",
      });
    } else if (toolName === "TaskUpdate") {
      const id = typeof args.taskId === "string" ? args.taskId : "";
      const existing = tasks.get(id);
      if (!existing) continue;
      if (
        args.status === "pending" || args.status === "in_progress" ||
        args.status === "completed" || args.status === "stopped"
      ) {
        existing.status = args.status as TaskInfo["status"];
      }
      if (typeof args.subject === "string") existing.subject = args.subject;
      if (typeof args.activeForm === "string") existing.activeForm = args.activeForm;
    } else if (toolName === "TaskStop") {
      const id = typeof args.taskId === "string" ? args.taskId : "";
      const existing = tasks.get(id);
      if (existing) existing.status = "stopped";
    }
  }

  if (tasks.size === 0) return null;
  return [...tasks.values()];
}

// ─── Stream helper ───────────────────────────────────────────────

function emitTaskUpdate(ctx: ToolContext | undefined, tasks: TaskInfo[]): void {
  // ToolContext.streamCallback is the in-turn stream sink the engine
  // installs before invoking the tool. May be undefined for headless
  // or test invocations.
  const cb = (ctx as ToolContext & { streamCallback?: StreamCallback } | undefined)?.streamCallback;
  cb?.({ type: "task_update", tasks });
}

function formatSnapshot(todos: TodoItem[]): string {
  if (todos.length === 0) return "Todo list cleared.";
  const completed = todos.filter((t) => t.status === "completed").length;
  const lines = todos.map((t) => {
    const icon =
      t.status === "completed" ? "✓" :
      t.status === "in_progress" ? "◐" : "○";
    const label = t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
    return `  ${icon} ${label}`;
  });
  return `Updated todo list (${completed}/${todos.length} done):\n${lines.join("\n")}`;
}
