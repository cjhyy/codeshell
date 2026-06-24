import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronScheduler } from "../automation/scheduler.js";
import { CCTaskStore } from "./cc-task-store.js";
import { runCCTask, makeCCAwareExecutor } from "./cc-scheduler-binding.js";

function tmpStore() { return new CCTaskStore(join(mkdtempSync(join(tmpdir(), "ccsb-")), "t.json")); }

describe("runCCTask", () => {
  it("always-fresh: 不传 resumeSessionId,回写新 sessionId", async () => {
    const store = tmpStore();
    store.set("j", { kind: "once", continuation: "always-fresh" });
    let sawResume: string | undefined = "SENTINEL";
    const runner = async (o: any) => { sawResume = o.resumeSessionId; return { sessionId: "NEW1", finalText: "ok", isError: false, exitCode: 0, lines: [] }; };
    await runCCTask({ jobId: "j", prompt: "do", cwd: "/x", store, runner, judge: async () => ({ action: "stop", reason: "" }), scheduler: new CronScheduler() });
    expect(sawResume).toBeUndefined();
    expect(store.get("j")?.sessionId).toBe("NEW1");
  });

  it("always-resume: 传已存 sessionId", async () => {
    const store = tmpStore();
    store.set("j", { kind: "once", continuation: "always-resume", sessionId: "OLD" });
    let sawResume: string | undefined;
    const runner = async (o: any) => { sawResume = o.resumeSessionId; return { sessionId: "OLD", finalText: "ok", isError: false, exitCode: 0, lines: [] }; };
    await runCCTask({ jobId: "j", prompt: "do", cwd: "/x", store, runner, judge: async () => ({ action: "continue-same", reason: "" }), scheduler: new CronScheduler() });
    expect(sawResume).toBe("OLD");
  });

  it("loop+auto+judge=continue-fresh: 清空 sessionId 供下轮开新,并存 handoff", async () => {
    const store = tmpStore();
    store.set("j", { kind: "loop", continuation: "auto", sessionId: "S1", goal: "g" });
    const runner = async () => ({ sessionId: "S1", finalText: "built X", isError: false, exitCode: 0, lines: [] });
    const judge = async () => ({ action: "continue-fresh" as const, handoffSummary: "did X", reason: "unrelated" });
    await runCCTask({ jobId: "j", prompt: "next", cwd: "/x", store, runner, judge, scheduler: new CronScheduler() });
    expect(store.get("j")?.sessionId).toBeUndefined();
    expect(store.get("j")?.handoffSummary).toBe("did X");
  });

  it("loop+auto+judge=stop: 禁用 job", async () => {
    const store = tmpStore();
    const scheduler = new CronScheduler();
    const created = scheduler.create("j-name", "30m", "next", { cwd: "/x" });
    store.set(created.id, { kind: "loop", continuation: "auto", sessionId: "S1", goal: "g" });
    const runner = async () => ({ sessionId: "S1", finalText: "all green", isError: false, exitCode: 0, lines: [] });
    const judge = async () => ({ action: "stop" as const, reason: "goal met" });
    await runCCTask({ jobId: created.id, prompt: "next", cwd: "/x", store, runner, judge, scheduler });
    expect(scheduler.get(created.id)?.enabled).toBe(false);
  });
});

describe("makeCCAwareExecutor", () => {
  it("routes CC jobs (has meta) to the CC runner, others to the fallback", async () => {
    const store = tmpStore();
    store.set("ccjob", { kind: "once", continuation: "always-fresh" });
    let ccRan = false, fallbackRan = false;
    const exec = makeCCAwareExecutor({
      store,
      runner: async () => { ccRan = true; return { sessionId: "S", finalText: "", isError: false, exitCode: 0, lines: [] }; },
      judge: async () => ({ action: "stop", reason: "" }),
      scheduler: new CronScheduler(),
      fallback: async () => { fallbackRan = true; },
    });
    await exec({ id: "ccjob", name: "", schedule: "1h", prompt: "p", enabled: true, runCount: 0, createdAt: 0, cwd: "/x" } as any, new AbortController().signal);
    expect(ccRan).toBe(true); expect(fallbackRan).toBe(false);
    await exec({ id: "other", name: "", schedule: "1h", prompt: "p", enabled: true, runCount: 0, createdAt: 0 } as any, new AbortController().signal);
    expect(fallbackRan).toBe(true);
  });
});
