import type {
  ToolContext,
  ToolDefinition,
  ToolVisibilityContext,
} from "@cjhyy/code-shell-core/extension";
import { hostActionService, hostActionAvailability } from "./host-actions.js";

export const TODOS_TOOL_NAME = "Todos";
export const MANAGE_TODO_TOOL_NAME = "ManageTodo";

export const PET_TODO_STATUSES = [
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "archived",
] as const;

export type PetTodoStatus = (typeof PET_TODO_STATUSES)[number];

export interface PetTodoItem {
  id: string;
  text: string;
  status: PetTodoStatus;
  createdAt: number;
  updatedAt: number;
  workspaceId?: string;
  sessionId?: string;
}

const TODO_MUTATION_ACTIONS = [
  "create",
  "update",
  "start",
  "block",
  "complete",
  "reopen",
  "archive",
] as const;

export const todosToolDef: ToolDefinition = {
  name: TODOS_TOOL_NAME,
  description:
    "Read Mimi's durable personal todo list. This is the user's own cross-session list, not a " +
    "Work Session's temporary TodoWrite execution steps. list returns active items; get returns " +
    "one exact item; search matches todo text.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["list", "get", "search"] },
      todo_id: { type: "string", minLength: 1, maxLength: 128 },
      query: { type: "string", minLength: 1, maxLength: 128 },
    },
    required: ["action"],
  },
};

export const manageTodoToolDef: ToolDefinition = {
  name: MANAGE_TODO_TOOL_NAME,
  description:
    "Create or mutate one item in Mimi's durable personal todo list. Use exact todo_id values " +
    "returned by Todos. start marks an item in progress; block marks it blocked; complete marks " +
    "it done; reopen returns it to pending; archive hides it without destructive deletion. The " +
    "host applies the mutation after this turn and appends the authoritative result.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: [...TODO_MUTATION_ACTIONS] },
      todo_id: { type: "string", minLength: 1, maxLength: 128 },
      text: { type: "string", minLength: 1, maxLength: 500 },
    },
    required: ["action"],
  },
};

export function todosAvailability(ctx: ToolVisibilityContext): boolean {
  return ctx.behaviorProfile === "pet" && ctx.profileMeta?.petTodos === true;
}

export const manageTodoAvailability = hostActionAvailability("todoMutation");

function visibleTodos(ctx?: ToolContext): readonly PetTodoItem[] | undefined {
  const value = (ctx?.runScopedServices as { petTodos?: unknown } | undefined)?.petTodos;
  return Array.isArray(value) ? (value as readonly PetTodoItem[]) : undefined;
}

export async function todosTool(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const todos = visibleTodos(ctx);
  if (!todos) return "Error: Todos is available only in a Mimi turn with a host todo snapshot.";
  if (
    Object.keys(args).some((key) => !["action", "todo_id", "query"].includes(key)) ||
    typeof args.action !== "string"
  ) {
    return "Error: Todos requires action and accepts only todo_id or query.";
  }
  if (args.action === "list") {
    if (args.todo_id !== undefined || args.query !== undefined) {
      return "Error: Todos list accepts no other arguments.";
    }
    return JSON.stringify({ todos: todos.filter((todo) => todo.status !== "archived") });
  }
  if (args.action === "get") {
    if (typeof args.todo_id !== "string" || args.query !== undefined) {
      return "Error: Todos get requires todo_id and accepts no query.";
    }
    const found = todos.find((todo) => todo.id === args.todo_id);
    return found ? JSON.stringify({ todo: found }) : `Error: todo not found: ${args.todo_id}`;
  }
  if (args.action !== "search") return "Error: Todos action must be list, get or search.";
  if (
    typeof args.query !== "string" ||
    !args.query.trim() ||
    args.query.length > 128 ||
    args.todo_id !== undefined
  ) {
    return "Error: Todos search requires a 1 to 128 character query.";
  }
  const query = args.query.trim().toLocaleLowerCase();
  return JSON.stringify({
    todos: todos.filter(
      (todo) => todo.status !== "archived" && todo.text.toLocaleLowerCase().includes(query),
    ),
  });
}

export async function manageTodoTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const request = hostActionService(ctx);
  if (!request) return "Error: ManageTodo is available only in a Mimi manager turn.";
  const action = args.action;
  const todoId = typeof args.todo_id === "string" ? args.todo_id.trim() : "";
  const text = typeof args.text === "string" ? args.text.replace(/\s+/gu, " ").trim() : "";
  if (!(TODO_MUTATION_ACTIONS as readonly unknown[]).includes(action)) {
    return `Error: unknown todo action ${JSON.stringify(action)}.`;
  }
  if ((action === "create" || action === "update") && (!text || text.length > 500)) {
    return "Error: create/update requires text of at most 500 characters.";
  }
  if (action !== "create" && !todoId) {
    return "Error: todo_id is required for every action except create.";
  }
  if (
    (action === "create" && args.todo_id !== undefined) ||
    (action !== "create" && action !== "update" && args.text !== undefined)
  ) {
    return "Error: invalid fields for the selected todo action.";
  }
  const payload: Record<string, unknown> = {
    action,
    ...(todoId ? { todoId } : {}),
    ...(text ? { text } : {}),
  };
  const decision = request({ kind: "todoMutation", payload });
  if (!decision.ok) return `Error: ${decision.error ?? "todo mutation was rejected"}`;
  return "Todo mutation accepted. The host will append the authoritative result after this turn.";
}
