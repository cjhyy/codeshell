/**
 * Built-in Task management tools — TaskCreate, TaskList, TaskUpdate, TaskStop.
 *
 * Provides an in-memory task list that the agent uses to track progress
 * on complex multi-step work. Tasks are displayed in the terminal UI
 * so the user can see what the agent is doing.
 */

import type { ToolDefinition, StreamCallback } from "../../types.js";

// ─── Task Types ──────────────────────────────────────────────────

export type TaskStatus = "pending" | "in_progress" | "completed" | "stopped";

export interface Task {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  blockedBy: string[];
  blocks: string[];
}

// ─── Task Manager (singleton) ────────────────────────────────────

class TaskManager {
  private tasks = new Map<string, Task>();
  private nextId = 1;
  private onUpdate?: StreamCallback;

  reset(): void {
    this.tasks.clear();
    this.nextId = 1;
  }

  setStreamCallback(cb?: StreamCallback): void {
    this.onUpdate = cb;
  }

  create(subject: string, description: string, activeForm?: string): Task {
    const id = String(this.nextId++);
    const now = Date.now();
    const task: Task = {
      id,
      subject,
      description,
      activeForm,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      blockedBy: [],
      blocks: [],
    };
    this.tasks.set(id, task);
    this.emitUpdate();
    return task;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  list(): Task[] {
    return [...this.tasks.values()];
  }

  update(id: string, updates: Partial<Pick<Task, "subject" | "description" | "activeForm" | "status">> & {
    addBlockedBy?: string[];
    addBlocks?: string[];
  }): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;

    if (updates.subject !== undefined) task.subject = updates.subject;
    if (updates.description !== undefined) task.description = updates.description;
    if (updates.activeForm !== undefined) task.activeForm = updates.activeForm;
    if (updates.status !== undefined) task.status = updates.status;

    if (updates.addBlockedBy) {
      for (const dep of updates.addBlockedBy) {
        if (!task.blockedBy.includes(dep)) task.blockedBy.push(dep);
        // Also set the reverse relationship
        const blocker = this.tasks.get(dep);
        if (blocker && !blocker.blocks.includes(id)) blocker.blocks.push(id);
      }
    }

    if (updates.addBlocks) {
      for (const dep of updates.addBlocks) {
        if (!task.blocks.includes(dep)) task.blocks.push(dep);
        const blocked = this.tasks.get(dep);
        if (blocked && !blocked.blockedBy.includes(id)) blocked.blockedBy.push(id);
      }
    }

    task.updatedAt = Date.now();
    this.emitUpdate();
    return task;
  }

  stop(id: string): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    task.status = "stopped";
    task.updatedAt = Date.now();
    this.emitUpdate();
    return task;
  }

  delete(id: string): boolean {
    const existed = this.tasks.delete(id);
    if (existed) this.emitUpdate();
    return existed;
  }

  private emitUpdate(): void {
    this.onUpdate?.({
      type: "task_update",
      tasks: this.list(),
    } as any);
  }
}

export const taskManager = new TaskManager();

// ─── Tool Definitions ────────────────────────────────────────────

export const taskCreateToolDef: ToolDefinition = {
  name: "TaskCreate",
  description:
    "Create a task to track progress on multi-step work. " +
    "Use this to break down complex tasks into discrete steps so the user can see your progress. " +
    "Only use when the work requires 3+ steps. Tasks are created with 'pending' status.",
  inputSchema: {
    type: "object",
    properties: {
      subject: {
        type: "string",
        description: "A brief, actionable title in imperative form (e.g., 'Fix authentication bug')",
      },
      description: {
        type: "string",
        description: "What needs to be done",
      },
      activeForm: {
        type: "string",
        description: "Present continuous form shown in spinner when in_progress (e.g., 'Fixing auth bug')",
      },
    },
    required: ["subject", "description"],
  },
};

export const taskListToolDef: ToolDefinition = {
  name: "TaskList",
  description:
    "List all tasks and their current status. Use this to check progress and find the next task to work on.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

export const taskUpdateToolDef: ToolDefinition = {
  name: "TaskUpdate",
  description:
    "Update a task's status or details. Mark tasks as 'in_progress' when starting work, " +
    "'completed' when done. Only mark completed when the work is FULLY accomplished.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "The ID of the task to update",
      },
      status: {
        type: "string",
        enum: ["pending", "in_progress", "completed", "stopped"],
        description: "New status for the task",
      },
      subject: {
        type: "string",
        description: "New subject for the task",
      },
      description: {
        type: "string",
        description: "New description for the task",
      },
      activeForm: {
        type: "string",
        description: "Present continuous form shown in spinner when in_progress",
      },
      addBlockedBy: {
        type: "array",
        items: { type: "string" },
        description: "Task IDs that must complete before this one can start",
      },
      addBlocks: {
        type: "array",
        items: { type: "string" },
        description: "Task IDs that cannot start until this one completes",
      },
    },
    required: ["taskId"],
  },
};

export const taskStopToolDef: ToolDefinition = {
  name: "TaskStop",
  description:
    "Stop/cancel a task that is no longer needed or was created in error.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "The ID of the task to stop",
      },
    },
    required: ["taskId"],
  },
};

// ─── Tool Implementations ────────────────────────────────────────

export async function taskCreateTool(args: Record<string, unknown>): Promise<string> {
  const subject = args.subject as string;
  const description = args.description as string;
  const activeForm = args.activeForm as string | undefined;

  if (!subject || !description) {
    return "Error: subject and description are required";
  }

  const task = taskManager.create(subject, description, activeForm);
  return `Task #${task.id} created successfully: ${task.subject}`;
}

export async function taskListTool(_args: Record<string, unknown>): Promise<string> {
  const tasks = taskManager.list();
  if (tasks.length === 0) {
    return "No tasks.";
  }

  const statusIcon: Record<TaskStatus, string> = {
    pending: "○",
    in_progress: "◉",
    completed: "✓",
    stopped: "✗",
  };

  const lines = tasks.map((t) => {
    const icon = statusIcon[t.status];
    const deps = t.blockedBy.length > 0 ? ` (blocked by: ${t.blockedBy.join(", ")})` : "";
    return `  ${icon} #${t.id} [${t.status}] ${t.subject}${deps}`;
  });

  return `Tasks (${tasks.length}):\n${lines.join("\n")}`;
}

export async function taskUpdateTool(args: Record<string, unknown>): Promise<string> {
  const taskId = args.taskId as string;
  if (!taskId) return "Error: taskId is required";

  const task = taskManager.get(taskId);
  if (!task) return `Error: Task #${taskId} not found`;

  // Handle "deleted" status as actual deletion
  if (args.status === "deleted") {
    taskManager.delete(taskId);
    return `Task #${taskId} deleted`;
  }

  const updated = taskManager.update(taskId, {
    status: args.status as TaskStatus | undefined,
    subject: args.subject as string | undefined,
    description: args.description as string | undefined,
    activeForm: args.activeForm as string | undefined,
    addBlockedBy: args.addBlockedBy as string[] | undefined,
    addBlocks: args.addBlocks as string[] | undefined,
  });

  if (!updated) return `Error: Task #${taskId} not found`;
  return `Updated task #${taskId} status`;
}

export async function taskStopTool(args: Record<string, unknown>): Promise<string> {
  const taskId = args.taskId as string;
  if (!taskId) return "Error: taskId is required";

  const task = taskManager.stop(taskId);
  if (!task) return `Error: Task #${taskId} not found`;
  return `Task #${taskId} stopped: ${task.subject}`;
}

// ─── TaskGet & TaskOutput ────────────────────────────────────────

export const taskGetToolDef: ToolDefinition = {
  name: "TaskGet",
  description: "Get detailed information about a specific task by ID.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "The ID of the task to retrieve" },
    },
    required: ["taskId"],
  },
};

export async function taskGetTool(args: Record<string, unknown>): Promise<string> {
  const taskId = args.taskId as string;
  if (!taskId) return "Error: taskId is required";

  const task = taskManager.get(taskId);
  if (!task) return `Error: Task #${taskId} not found`;

  const lines = [
    `Task #${task.id}`,
    `  Subject:     ${task.subject}`,
    `  Status:      ${task.status}`,
    `  Description: ${task.description}`,
  ];
  if (task.activeForm) lines.push(`  Active form: ${task.activeForm}`);
  if (task.blockedBy.length) lines.push(`  Blocked by:  ${task.blockedBy.join(", ")}`);
  if (task.blocks.length) lines.push(`  Blocks:      ${task.blocks.join(", ")}`);
  lines.push(`  Created:     ${new Date(task.createdAt).toLocaleString()}`);
  lines.push(`  Updated:     ${new Date(task.updatedAt).toLocaleString()}`);
  return lines.join("\n");
}

export const taskOutputToolDef: ToolDefinition = {
  name: "TaskOutput",
  description: "Get the output/result of a completed task.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "The ID of the task" },
    },
    required: ["taskId"],
  },
};

export async function taskOutputTool(args: Record<string, unknown>): Promise<string> {
  const taskId = args.taskId as string;
  if (!taskId) return "Error: taskId is required";

  const task = taskManager.get(taskId);
  if (!task) return `Error: Task #${taskId} not found`;
  if (task.status !== "completed" && task.status !== "stopped") {
    return `Task #${taskId} is still ${task.status}. No output yet.`;
  }
  return `Task #${taskId} (${task.status}): ${task.subject}\n\nDescription: ${task.description}`;
}
