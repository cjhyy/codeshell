import { afterEach, describe, expect, test } from "bun:test";
import { asyncAgentRegistry } from "./agent-registry.js";
import { backgroundJobRegistry } from "./background-jobs.js";
import { cancelBackgroundWorkForUI, listBackgroundWorkForUI } from "./background-work.js";

afterEach(() => {
  asyncAgentRegistry.reset();
  backgroundJobRegistry.reset();
});

describe("authoritative background work control", () => {
  test("subagent cancellation requires source ownership and exact attempt generation", async () => {
    let aborts = 0;
    asyncAgentRegistry.register({
      agentId: "agent-a",
      sessionId: "parent-a",
      childSessionId: "child-a",
      runtimeGeneration: 2,
      description: "Work",
      status: "running",
      startedAt: 100,
      abort: () => {
        aborts++;
      },
    });
    const row = listBackgroundWorkForUI("parent-a")[0]!;
    expect(row).toMatchObject({
      kind: "subagent",
      childSessionId: "child-a",
      runtimeGeneration: 2,
      canCancel: true,
    });
    const request = {
      kind: "subagent" as const,
      workId: "agent-a",
      sessionId: "parent-a",
      expectedStartedAt: 100,
      expectedRuntimeGeneration: 2,
    };
    expect(await cancelBackgroundWorkForUI({ ...request, sessionId: "other-parent" })).toBe(false);
    expect(await cancelBackgroundWorkForUI({ ...request, expectedRuntimeGeneration: 1 })).toBe(
      false,
    );
    expect(await cancelBackgroundWorkForUI({ ...request, expectedStartedAt: 99 })).toBe(false);
    expect(aborts).toBe(0);
    expect(await cancelBackgroundWorkForUI(request)).toBe(true);
    expect(await cancelBackgroundWorkForUI(request)).toBe(false);
    expect(aborts).toBe(1);
  });

  test("jobs without real abort hooks are view-only; cancellation awaits actual controller", async () => {
    backgroundJobRegistry.start("readonly-job", "parent-a", "Readonly");
    let aborts = 0;
    backgroundJobRegistry.start("controlled-job", "parent-a", "Controlled", {
      abort: async () => {
        aborts++;
        return { status: "cancelled" };
      },
    });
    expect(
      listBackgroundWorkForUI("parent-a")
        .filter((row) => row.kind === "job")
        .map((row) => row.canCancel),
    ).toEqual([false, true]);
    const startedAt = backgroundJobRegistry.get("controlled-job")!.startedAt;
    expect(
      await cancelBackgroundWorkForUI({
        kind: "job",
        workId: "readonly-job",
        sessionId: "parent-a",
        expectedStartedAt: backgroundJobRegistry.get("readonly-job")!.startedAt,
      }),
    ).toBe(false);
    expect(
      await cancelBackgroundWorkForUI({
        kind: "job",
        workId: "controlled-job",
        sessionId: "wrong",
        expectedStartedAt: startedAt,
      }),
    ).toBe(false);
    expect(aborts).toBe(0);
    expect(
      await cancelBackgroundWorkForUI({
        kind: "job",
        workId: "controlled-job",
        sessionId: "parent-a",
        expectedStartedAt: startedAt,
      }),
    ).toBe(true);
    expect(backgroundJobRegistry.get("controlled-job")!.status).toBe("cancelled");
    expect(aborts).toBe(1);
  });
});
