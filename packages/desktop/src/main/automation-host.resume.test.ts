import { describe, test, expect } from "bun:test";
import { makeCronRunnerWithResume } from "./automation-host.js";
import type { CronRunRequest, CronRunResult } from "@cjhyy/code-shell-core";

// A resume job (job.resumeSessionId set) must NOT run the isolated headless
// runner. Instead it feeds its prompt as a user turn into the LIVE session via
// injectResume — the "cron = a human typing at a scheduled time" model. A job
// without resumeSessionId keeps running the headless isolated-automation path.

function req(over: Partial<CronRunRequest> & { job?: Partial<CronRunRequest["job"]> } = {}): CronRunRequest {
  return {
    job: {
      id: "job-1",
      name: "t",
      schedule: "1h",
      prompt: "do the thing",
      enabled: true,
      runCount: 0,
      createdAt: 0,
      ...(over.job ?? {}),
    } as CronRunRequest["job"],
    prompt: over.prompt ?? "do the thing",
    permissionMode: "default",
    // The approval backend / sandbox are irrelevant to the branch decision.
    approvalBackend: {} as CronRunRequest["approvalBackend"],
    sandboxMode: "auto",
    signal: over.signal,
  };
}

describe("makeCronRunnerWithResume — routes by job.resumeSessionId", () => {
  test("resumeSessionId set → injectResume (NOT the headless runner)", async () => {
    const calls: { headless: number; inject: Array<{ sid: string; prompt: string }> } = {
      headless: 0,
      inject: [],
    };
    const headless = async (): Promise<CronRunResult> => {
      calls.headless++;
      return { text: "headless", reason: "done" };
    };
    const inject = async (sid: string, prompt: string): Promise<CronRunResult> => {
      calls.inject.push({ sid, prompt });
      return { text: "injected", reason: "done" };
    };
    const runner = makeCronRunnerWithResume(headless, inject);

    const r = await runner(req({ job: { resumeSessionId: "sess-42" }, prompt: "接着做" }));

    expect(calls.headless).toBe(0);
    expect(calls.inject).toEqual([{ sid: "sess-42", prompt: "接着做" }]);
    expect(r.text).toBe("injected");
  });

  test("no resumeSessionId → headless runner (isolated automation, regression)", async () => {
    let headlessCalls = 0;
    let injectCalls = 0;
    const headless = async (): Promise<CronRunResult> => {
      headlessCalls++;
      return { text: "headless", reason: "done" };
    };
    const inject = async (): Promise<CronRunResult> => {
      injectCalls++;
      return { text: "injected", reason: "done" };
    };
    const runner = makeCronRunnerWithResume(headless, inject);

    const r = await runner(req());

    expect(headlessCalls).toBe(1);
    expect(injectCalls).toBe(0);
    expect(r.text).toBe("headless");
  });

  test("empty-string resumeSessionId is treated as absent → headless", async () => {
    let headlessCalls = 0;
    let injectCalls = 0;
    const runner = makeCronRunnerWithResume(
      async () => {
        headlessCalls++;
        return { text: "headless", reason: "done" };
      },
      async () => {
        injectCalls++;
        return { text: "injected", reason: "done" };
      },
    );

    await runner(req({ job: { resumeSessionId: "" } }));

    expect(headlessCalls).toBe(1);
    expect(injectCalls).toBe(0);
  });

  test("forwards the abort signal to injectResume", async () => {
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    const runner = makeCronRunnerWithResume(
      async () => ({ text: "headless", reason: "done" }),
      async (_sid, _prompt, signal) => {
        seen = signal;
        return { text: "injected", reason: "done" };
      },
    );

    await runner(req({ job: { resumeSessionId: "sess-42" }, signal: ac.signal }));

    expect(seen).toBe(ac.signal);
  });
});
