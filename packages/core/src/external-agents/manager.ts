import type {
  ExternalAgentAdapter,
  ExternalAgentEvent,
  ExternalAgentJob,
  StartExternalAgentJobInput,
} from "./types.js";

export interface ExternalAgentJobManagerAdapters {
  claudeCode: ExternalAgentAdapter;
  codex?: ExternalAgentAdapter;
}

export class ExternalAgentJobManager {
  private jobs = new Map<string, ExternalAgentJob>();

  constructor(
    private readonly adapters: ExternalAgentJobManagerAdapters,
    private readonly onEvent: (event: ExternalAgentEvent) => void,
  ) {}

  start(input: StartExternalAgentJobInput): ExternalAgentJob {
    const adapter =
      input.kind === "claude-code" ? this.adapters.claudeCode : this.adapters.codex;
    if (!adapter) throw new Error(`No adapter registered for ${input.kind}`);
    const job = adapter.start(input, (event) => {
      if ("job" in event) this.jobs.set(event.job.id, event.job);
      this.onEvent(event);
    });
    this.jobs.set(job.id, job);
    return job;
  }

  get(jobId: string): ExternalAgentJob | undefined {
    return this.jobs.get(jobId);
  }

  listForSession(sessionId: string): ExternalAgentJob[] {
    return [...this.jobs.values()].filter((job) => job.sessionId === sessionId);
  }

  async stop(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    const adapter =
      job.kind === "claude-code" ? this.adapters.claudeCode : this.adapters.codex;
    if (!adapter) return false;
    return adapter.stop(jobId);
  }
}
