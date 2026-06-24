import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type Continuation = "auto" | "always-resume" | "always-fresh";

export interface CCTaskMeta {
  kind: "once" | "loop";
  continuation: Continuation;
  goal?: string;
  sessionId?: string;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions";
  /** Set when a fresh-session decision left a context summary to prepend to the
   *  next run's prompt. Consumed (cleared) by the next run. */
  handoffSummary?: string;
}

export function defaultCCTaskStorePath(): string {
  return join(homedir(), ".code-shell", "cc-tasks.json");
}

interface Snapshot { version: 1; tasks: Record<string, CCTaskMeta>; }

/** Side-store for CC-specific task metadata, keyed by CronJob id. */
export class CCTaskStore {
  private readonly file: string;
  constructor(file?: string) { this.file = file ?? defaultCCTaskStorePath(); }

  private read(): Record<string, CCTaskMeta> {
    if (!existsSync(this.file)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf-8")) as Snapshot;
      return parsed?.tasks && typeof parsed.tasks === "object" ? parsed.tasks : {};
    } catch { return {}; }
  }
  private write(tasks: Record<string, CCTaskMeta>): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, tasks } satisfies Snapshot, null, 2));
    renameSync(tmp, this.file);
  }
  get(jobId: string): CCTaskMeta | undefined { return this.read()[jobId]; }
  set(jobId: string, meta: CCTaskMeta): void { const all = this.read(); all[jobId] = meta; this.write(all); }
  patch(jobId: string, patch: Partial<CCTaskMeta>): void {
    const all = this.read();
    all[jobId] = { ...(all[jobId] ?? { kind: "once", continuation: "auto" }), ...patch };
    this.write(all);
  }
  delete(jobId: string): void { const all = this.read(); delete all[jobId]; this.write(all); }
}
