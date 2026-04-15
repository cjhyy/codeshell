/**
 * TodoWriteTool — legacy todo list management (maps to task system).
 */

import type { ToolDefinition } from "../../types.js";
import { taskManager } from "./task.js";

export const todoWriteToolDef: ToolDefinition = {
  name: "TodoWrite",
  description:
    "Write and manage a todo list for tracking tasks. " +
    "This is a convenience wrapper around the task system.",
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique ID for the todo" },
            content: { type: "string", description: "Description of the todo item" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
              description: "Status of the todo",
            },
          },
          required: ["id", "content", "status"],
        },
        description: "The complete todo list to write",
      },
    },
    required: ["todos"],
  },
};

export async function todoWriteTool(args: Record<string, unknown>): Promise<string> {
  const todos = args.todos as Array<{
    id: string;
    content: string;
    status: string;
  }>;

  if (!todos || !Array.isArray(todos)) {
    return "Error: todos array is required.";
  }

  // Map todos to the task system
  const existing = taskManager.list();
  const existingIds = new Set(existing.map((t) => t.id));

  for (const todo of todos) {
    if (existingIds.has(todo.id)) {
      // Update existing
      taskManager.update(todo.id, {
        status: todo.status as "pending" | "in_progress" | "completed",
        description: todo.content,
      });
    } else {
      // Create new
      taskManager.create(todo.content, todo.content);
    }
  }

  const summary = taskManager.list();
  const lines = summary.map(
    (t) => `  [${t.status === "completed" ? "✓" : t.status === "in_progress" ? "▶" : " "}] ${t.subject}`,
  );
  return `Todo list updated (${summary.length} items):\n${lines.join("\n")}`;
}
