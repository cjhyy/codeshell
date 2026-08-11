import { describe, expect, test } from "bun:test";
import {
  PanelAppAgentTaskService,
  type PanelAgentTaskOwner,
  type PanelAgentTaskRuntime,
} from "./panel-app-agent-task-service.js";

function owner(): PanelAgentTaskOwner {
  return {
    guestId: 7,
    ownerWebContentsId: 9,
    appId: "video-download",
    appTitle: "Video Download",
    projectPath: "/repo",
    cwd: "/repo",
    bucket: "repo::session",
    availableSkills: ["video-download:video-download-setup"],
  };
}

describe("PanelAppAgentTaskService", () => {
  test("runs an isolated bounded task and publishes its result", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const events: Array<{ status: string; text?: string }> = [];
    const runtime: PanelAgentTaskRuntime = {
      run: async (input) => {
        calls.push(input as unknown as Record<string, unknown>);
        return {
          text: "ready",
          reason: "completed",
          usage: { promptTokens: 20, completionTokens: 4, totalTokens: 24 },
        };
      },
      cancel: async () => undefined,
      close: async () => undefined,
      rebind: () => undefined,
    };
    let id = 0;
    const service = new PanelAppAgentTaskService(
      runtime,
      (_owner, task) => events.push({ status: task.status, text: task.result?.text }),
      () => 100 + id,
      () => String(++id),
    );

    const started = service.start(owner(), {
      prompt: "initialize",
      label: "Initialize downloader",
      key: "setup",
      skill: "video-download:video-download-setup",
      toolNames: ["Panel", "Bash"],
      maxTurns: 12,
    });
    expect(started.status).toBe("running");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const completed = service.get(owner(), started.id);
    expect(completed.status).toBe("completed");
    expect(completed.result?.text).toBe("ready");
    expect(calls[0]).toMatchObject({
      sessionId: "panel-task-2",
      toolNames: ["Panel", "Bash", "Skill"],
      skillNames: ["video-download:video-download-setup"],
      maxTurns: 12,
      maxContextTokens: 32768,
    });
    expect(events.map((event) => event.status)).toEqual(["queued", "running", "completed"]);
  });

  test("deduplicates an active key and rejects another app's Skill", async () => {
    let finish = (): void => undefined;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const runtime: PanelAgentTaskRuntime = {
      run: async () => {
        await blocked;
        return { text: "done" };
      },
      cancel: async () => undefined,
      close: async () => undefined,
      rebind: () => undefined,
    };
    const service = new PanelAppAgentTaskService(runtime, () => undefined);
    const first = service.start(owner(), { prompt: "a", label: "A", key: "setup" });
    const second = service.start(owner(), { prompt: "b", label: "B", key: "setup" });
    expect(second.id).toBe(first.id);
    expect(() =>
      service.start(owner(), {
        prompt: "x",
        label: "X",
        skill: "other:secret",
      }),
    ).toThrow(/not bundled/);
    finish();
  });

  test("cancels a running task and rebinds it to the current panel bucket", async () => {
    let rejectRun = (_error: Error): void => undefined;
    const running = new Promise<never>((_resolve, reject) => {
      rejectRun = reject;
    });
    const cancelled: string[] = [];
    const rebound: string[] = [];
    const runtime: PanelAgentTaskRuntime = {
      run: async () => running,
      cancel: async (sessionId) => {
        cancelled.push(sessionId);
        rejectRun(new Error("cancelled"));
      },
      close: async () => undefined,
      rebind: (_sessionId, nextOwner) => rebound.push(nextOwner.bucket),
    };
    const service = new PanelAppAgentTaskService(
      runtime,
      () => undefined,
      Date.now,
      () => "fixed",
    );
    const started = service.start(owner(), { prompt: "work", label: "Work" });
    const nextOwner = { ...owner(), bucket: "repo::next" };
    service.rebind(nextOwner);
    await service.cancel(nextOwner, started.id);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rebound).toEqual(["repo::next"]);
    expect(cancelled).toEqual(["panel-task-fixed"]);
    expect(service.get(nextOwner, started.id).status).toBe("cancelled");
  });
});
