/**
 * Cross-session TodoWrite snapshot reader.
 *
 * Semantics mirror packages/core/src/tool-system/builtin/task.ts
 * readLastTodoSnapshot (newest-first tool_use TodoWrite lookup, "all items
 * completed -> clear panel" rule). Kept as a local copy — this package can't
 * import core runtime, only types — same precedent as desktop's
 * transcript-reader.ts todosToTasks().
 */
import { join } from "node:path";
import { readTranscriptTail } from "./jsonl.js";

export type SessionTodoStatus = "pending" | "in_progress" | "completed";

export interface SessionTodoItem {
  id: string;
  subject: string;
  activeForm: string;
  status: SessionTodoStatus;
}

interface ParsedTodo {
  content: string;
  status: SessionTodoStatus;
  activeForm: string;
}

function parseTodos(raw: unknown[]): ParsedTodo[] {
  const out: ParsedTodo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.content !== "string") continue;
    const status = obj.status;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") continue;
    const activeForm = typeof obj.activeForm === "string" ? obj.activeForm : obj.content;
    out.push({ content: obj.content, status, activeForm });
  }
  return out;
}

function toSessionTodoItems(todos: ParsedTodo[]): SessionTodoItem[] {
  return todos.map((todo, index) => ({
    id: String(index + 1),
    subject: todo.content,
    activeForm: todo.activeForm,
    status: todo.status,
  }));
}

export async function readSessionTodos(sessionDir: string): Promise<SessionTodoItem[] | null> {
  const events = await readTranscriptTail(join(sessionDir, "transcript.jsonl"));
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type !== "tool_use") continue;
    const data = event.data ?? {};
    if (data.toolName !== "TodoWrite") continue;
    const args = (data.args ?? {}) as Record<string, unknown>;
    const todos = args.todos;
    if (!Array.isArray(todos)) continue;
    const parsed = parseTodos(todos);
    const allDone = parsed.length > 0 && parsed.every((todo) => todo.status === "completed");
    return allDone ? [] : toSessionTodoItems(parsed);
  }
  return null;
}
