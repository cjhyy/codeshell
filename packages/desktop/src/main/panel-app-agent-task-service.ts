import { randomUUID } from "node:crypto";

export type PanelAgentTaskStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export type PanelAgentTaskActivityKind = "model" | "tool" | "plan" | "error";
export type PanelAgentTaskActivityStatus = "running" | "completed" | "failed";

export interface PanelAgentTaskActivity {
  kind: PanelAgentTaskActivityKind;
  status: PanelAgentTaskActivityStatus;
  message: string;
  toolName?: string;
  at: number;
}

export interface PanelAgentTaskProgressInput {
  kind: PanelAgentTaskActivityKind;
  status: PanelAgentTaskActivityStatus;
  message: string;
  toolName?: string;
}

export interface PanelAgentTaskView {
  id: string;
  key?: string;
  label: string;
  status: PanelAgentTaskStatus;
  skill?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  result?: {
    text: string;
    reason?: string;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  };
  error?: string;
  activity?: PanelAgentTaskActivity[];
}

export interface PanelAgentTaskOwner {
  guestId: number;
  ownerWebContentsId: number;
  appId: string;
  appTitle: string;
  projectPath: string;
  cwd: string;
  bucket: string;
  availableSkills: readonly string[];
}

export interface PanelAgentTaskStartInput {
  prompt?: unknown;
  label?: unknown;
  key?: unknown;
  skill?: unknown;
  toolNames?: unknown;
  maxTurns?: unknown;
  maxContextTokens?: unknown;
}

export interface PanelAgentTaskRuntime {
  run(input: {
    sessionId: string;
    owner: PanelAgentTaskOwner;
    prompt: string;
    label: string;
    toolNames: string[];
    skillNames: string[];
    maxTurns: number;
    maxContextTokens: number;
    onProgress: (progress: PanelAgentTaskProgressInput) => void;
  }): Promise<{
    text: string;
    reason?: string;
    error?: string;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  }>;
  cancel(sessionId: string): Promise<void>;
  close(sessionId: string): Promise<void>;
  rebind(sessionId: string, owner: PanelAgentTaskOwner): void;
}

interface StoredPanelAgentTask extends PanelAgentTaskView {
  sessionId: string;
  owner: PanelAgentTaskOwner;
  prompt: string;
  toolNames: string[];
  skillNames: string[];
  maxTurns: number;
  maxContextTokens: number;
  cancelRequested: boolean;
}

const MAX_TASKS = 200;
const MAX_PROMPT_CHARS = 20_000;
const MAX_RESULT_CHARS = 64_000;
const MAX_ACTIVITY_ITEMS = 40;
const MAX_ACTIVITY_MESSAGE_CHARS = 500;
const TERMINAL_STATUSES = new Set<PanelAgentTaskStatus>(["completed", "failed", "cancelled"]);
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const TASK_KEY = /^[a-z][a-z0-9_-]{0,63}$/;

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error || "Task failed")).slice(0, 1_000);
}

function failureForReason(reason: string | undefined): string {
  switch (reason) {
    case "model_error":
      return "The AI model request failed. Check the selected model and its API credentials.";
    case "prompt_too_long":
      return "The Task prompt exceeded the model context limit.";
    case "max_turns":
      return "The Task reached its turn limit before finishing.";
    case "goal_budget_exhausted":
      return "The Task reached its configured budget before finishing.";
    case "aborted_streaming":
    case "aborted_tools":
      return "The Task was interrupted before finishing.";
    default:
      return reason ? `The Task ended before completion (${reason}).` : "Task failed";
  }
}

function publicTask(task: StoredPanelAgentTask): PanelAgentTaskView {
  return {
    id: task.id,
    ...(task.key ? { key: task.key } : {}),
    label: task.label,
    status: task.status,
    ...(task.skill ? { skill: task.skill } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.completedAt ? { completedAt: task.completedAt } : {}),
    ...(task.result ? { result: structuredClone(task.result) } : {}),
    ...(task.error ? { error: task.error } : {}),
    ...(task.activity?.length ? { activity: structuredClone(task.activity) } : {}),
  };
}

function sameScope(task: StoredPanelAgentTask, owner: PanelAgentTaskOwner): boolean {
  return task.owner.appId === owner.appId && task.owner.projectPath === owner.projectPath;
}

export class PanelAppAgentTaskService {
  private readonly tasks = new Map<string, StoredPanelAgentTask>();

  constructor(
    private readonly runtime: PanelAgentTaskRuntime,
    private readonly emitChanged: (owner: PanelAgentTaskOwner, task: PanelAgentTaskView) => void,
    private readonly now: () => number = Date.now,
    private readonly makeId: () => string = randomUUID,
  ) {}

  start(owner: PanelAgentTaskOwner, raw: PanelAgentTaskStartInput): PanelAgentTaskView {
    const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
    if (!prompt || prompt.length > MAX_PROMPT_CHARS) {
      throw new Error("agent.task.start requires a non-empty prompt up to 20000 characters");
    }
    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    if (!label || label.length > 200) {
      throw new Error("agent.task.start requires a non-empty label up to 200 characters");
    }
    const key = raw.key === undefined ? undefined : String(raw.key);
    if (key !== undefined && !TASK_KEY.test(key)) {
      throw new Error("agent.task.start key must match ^[a-z][a-z0-9_-]{0,63}$");
    }
    const skill = raw.skill === undefined ? undefined : String(raw.skill);
    if (skill !== undefined && !owner.availableSkills.includes(skill)) {
      throw new Error(`Task Skill '${skill}' is not bundled with this Panel App`);
    }
    const requestedTools = raw.toolNames === undefined ? [] : raw.toolNames;
    if (
      !Array.isArray(requestedTools) ||
      requestedTools.length > 32 ||
      requestedTools.some((name) => typeof name !== "string" || !TOOL_NAME.test(name))
    ) {
      throw new Error("agent.task.start toolNames must contain at most 32 valid tool names");
    }
    const maxTurns = raw.maxTurns === undefined ? 8 : Number(raw.maxTurns);
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 20) {
      throw new Error("agent.task.start maxTurns must be an integer from 1 to 20");
    }
    const maxContextTokens =
      raw.maxContextTokens === undefined ? 32_768 : Number(raw.maxContextTokens);
    if (
      !Number.isInteger(maxContextTokens) ||
      maxContextTokens < 4_096 ||
      maxContextTokens > 65_536
    ) {
      throw new Error("agent.task.start maxContextTokens must be from 4096 to 65536");
    }

    if (key) {
      const existing = [...this.tasks.values()].find(
        (task) => sameScope(task, owner) && task.key === key && !TERMINAL_STATUSES.has(task.status),
      );
      if (existing) return publicTask(existing);
    }

    const createdAt = this.now();
    const id = `task-${this.makeId()}`;
    const toolNames = [...new Set(requestedTools as string[])];
    if (skill && !toolNames.includes("Skill")) toolNames.push("Skill");
    const task: StoredPanelAgentTask = {
      id,
      ...(key ? { key } : {}),
      label,
      status: "queued",
      ...(skill ? { skill } : {}),
      createdAt,
      updatedAt: createdAt,
      sessionId: `panel-task-${this.makeId()}`,
      owner: { ...owner, availableSkills: [...owner.availableSkills] },
      prompt,
      toolNames,
      skillNames: skill ? [skill] : [],
      maxTurns,
      maxContextTokens,
      cancelRequested: false,
      activity: [],
    };
    this.tasks.set(task.id, task);
    this.trimHistory();
    this.emit(task);
    void this.execute(task);
    return publicTask(task);
  }

  list(owner: PanelAgentTaskOwner): PanelAgentTaskView[] {
    return [...this.tasks.values()]
      .filter((task) => sameScope(task, owner))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(publicTask);
  }

  get(owner: PanelAgentTaskOwner, id: unknown): PanelAgentTaskView {
    const task = this.scopedTask(owner, id);
    return publicTask(task);
  }

  async cancel(owner: PanelAgentTaskOwner, id: unknown): Promise<PanelAgentTaskView> {
    const task = this.scopedTask(owner, id);
    if (TERMINAL_STATUSES.has(task.status)) return publicTask(task);
    task.cancelRequested = true;
    task.status = "cancelling";
    task.updatedAt = this.now();
    this.emit(task);
    try {
      await this.runtime.cancel(task.sessionId);
    } catch (error) {
      task.error = cleanError(error);
      task.updatedAt = this.now();
      this.emit(task);
    }
    return publicTask(task);
  }

  rebind(owner: PanelAgentTaskOwner): void {
    for (const task of this.tasks.values()) {
      if (!sameScope(task, owner) || TERMINAL_STATUSES.has(task.status)) continue;
      task.owner = { ...owner, availableSkills: [...owner.availableSkills] };
      this.runtime.rebind(task.sessionId, task.owner);
    }
  }

  cancelApp(appId: string): void {
    for (const task of this.tasks.values()) {
      if (task.owner.appId !== appId || TERMINAL_STATUSES.has(task.status)) continue;
      task.cancelRequested = true;
      task.status = "cancelling";
      task.updatedAt = this.now();
      this.emit(task);
      void this.runtime.cancel(task.sessionId).catch(() => undefined);
    }
  }

  private async execute(task: StoredPanelAgentTask): Promise<void> {
    task.status = "running";
    task.updatedAt = this.now();
    this.emit(task);
    try {
      const result = await this.runtime.run({
        sessionId: task.sessionId,
        owner: task.owner,
        prompt: task.prompt,
        label: task.label,
        toolNames: task.toolNames,
        skillNames: task.skillNames,
        maxTurns: task.maxTurns,
        maxContextTokens: task.maxContextTokens,
        onProgress: (progress) => this.recordProgress(task, progress),
      });
      task.result = {
        text: String(result.text || "").slice(0, MAX_RESULT_CHARS),
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
      };
      if (task.cancelRequested) {
        task.status = "cancelled";
      } else if (result.reason && result.reason !== "completed") {
        task.status = "failed";
        task.error = cleanError(result.error || result.text || failureForReason(result.reason));
      } else {
        task.status = "completed";
      }
    } catch (error) {
      task.status = task.cancelRequested ? "cancelled" : "failed";
      task.error = cleanError(error);
    } finally {
      task.updatedAt = this.now();
      task.completedAt = task.updatedAt;
      this.emit(task);
      await this.runtime.close(task.sessionId).catch(() => undefined);
    }
  }

  private scopedTask(owner: PanelAgentTaskOwner, id: unknown): StoredPanelAgentTask {
    if (typeof id !== "string" || !id) throw new Error("agent.task requires a task id");
    const task = this.tasks.get(id);
    if (!task || !sameScope(task, owner)) throw new Error("Task not found for this Panel App");
    return task;
  }

  private emit(task: StoredPanelAgentTask): void {
    this.emitChanged(task.owner, publicTask(task));
  }

  private recordProgress(task: StoredPanelAgentTask, progress: PanelAgentTaskProgressInput): void {
    if (TERMINAL_STATUSES.has(task.status)) return;
    const message = String(progress.message || "")
      .trim()
      .slice(0, MAX_ACTIVITY_MESSAGE_CHARS);
    if (!message) return;
    const toolName = progress.toolName?.trim().slice(0, 128);
    const previous = task.activity?.at(-1);
    if (
      previous?.kind === progress.kind &&
      previous.status === progress.status &&
      previous.message === message &&
      previous.toolName === toolName
    ) {
      return;
    }
    task.activity ??= [];
    task.activity.push({
      kind: progress.kind,
      status: progress.status,
      message,
      ...(toolName ? { toolName } : {}),
      at: this.now(),
    });
    if (task.activity.length > MAX_ACTIVITY_ITEMS) {
      task.activity.splice(0, task.activity.length - MAX_ACTIVITY_ITEMS);
    }
    task.updatedAt = this.now();
    this.emit(task);
  }

  private trimHistory(): void {
    if (this.tasks.size <= MAX_TASKS) return;
    for (const task of this.tasks.values()) {
      if (!TERMINAL_STATUSES.has(task.status)) continue;
      this.tasks.delete(task.id);
      if (this.tasks.size <= MAX_TASKS) return;
    }
  }
}
