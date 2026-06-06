import { describe, expect, test } from "bun:test";
import { ExternalAgentJobManager } from "./manager.js";
import type {
  ExternalAgentAdapter,
  ExternalAgentEvent,
  StartExternalAgentJobInput,
} from "./types.js";

class FakeAdapter implements ExternalAgentAdapter {
  starts: StartExternalAgentJobInput[] = [];
  stopped: string[] = [];

  start(input: StartExternalAgentJobInput, onEvent: (event: ExternalAgentEvent) => void) {
    this.starts.push(input);
    const job = {
      id: "job_fake",
      kind: input.kind,
      sessionId: input.sessionId,
      cwd: input.cwd,
      prompt: input.prompt,
      mode: input.mode ?? "safe",
      args: input.args ?? [],
      status: "running" as const,
      startedAt: 123,
    };
    onEvent({ type: "job.started", job });
    return job;
  }

  async stop(jobId: string) {
    this.stopped.push(jobId);
    return true;
  }
}

describe("ExternalAgentJobManager", () => {
  test("starts a job and records events", () => {
    const adapter = new FakeAdapter();
    const events: ExternalAgentEvent[] = [];
    const mgr = new ExternalAgentJobManager({ claudeCode: adapter }, (event) =>
      events.push(event),
    );

    const job = mgr.start({
      kind: "claude-code",
      sessionId: "s1",
      cwd: "/repo",
      prompt: "fix tests",
      command: "claude",
      mode: "dangerous",
      args: ["--dangerously-skip-permissions"],
    });

    expect(job.id).toBe("job_fake");
    expect(adapter.starts[0]?.prompt).toBe("fix tests");
    expect(mgr.get("job_fake")?.status).toBe("running");
    expect(events[0]?.type).toBe("job.started");
  });

  test("stops a running job", async () => {
    const adapter = new FakeAdapter();
    const mgr = new ExternalAgentJobManager({ claudeCode: adapter }, () => {});
    mgr.start({
      kind: "claude-code",
      sessionId: "s1",
      cwd: "/repo",
      prompt: "x",
      command: "claude",
    });
    await expect(mgr.stop("job_fake")).resolves.toBe(true);
    expect(adapter.stopped).toEqual(["job_fake"]);
  });
});
