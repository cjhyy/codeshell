import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PetLongTask } from "@cjhyy/code-shell-pet";
import { sessionSelectorId } from "@cjhyy/code-shell-pet/disclosure";
import { PetDispatchService, type PetAutoDelegation } from "./pet-dispatch-service.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function task(overrides: Partial<PetLongTask> = {}): PetLongTask {
  return {
    schemaVersion: 1,
    id: "task-original",
    originClientMessageId: "user-original",
    objective: "Verify every source address. Record renamed targets without modifying them.",
    workspacePath: "/work/original",
    sessionId: "work-original",
    verificationMode: "turn",
    status: "failed",
    phase: "finalizing",
    attempt: 1,
    revision: 2,
    createdAt: 1,
    updatedAt: 2,
    completedAt: 2,
    resultSummary: "Rows 1–2 verified; preserve the exact addresses in source.json.",
    artifacts: [],
    events: [],
    ...overrides,
  };
}

function harness(
  options: {
    mutate?: (delegation: Record<string, unknown>) => void;
    launchError?: string;
    busy?: boolean;
    goalState?: Record<string, unknown>;
  } = {},
) {
  const starts: PetAutoDelegation[] = [];
  const replies: unknown[] = [];
  const paramsSeen: Record<string, unknown>[] = [];
  const service = new PetDispatchService({
    metadata: { ensure: async () => ({ petSessionId: "mimi" }) },
    aggregator: {
      getSnapshot: () => ({
        version: 1,
        generation: 1,
        observedAt: 1,
        workerState: "active",
        sessions: options.busy
          ? ([
              { agentSessionId: "work-original", runState: "running", pendingDecisionCount: 0 },
            ] as never)
          : [],
        pending: [],
      }),
      resolveNavigation: async () => ({ status: "not-found" }),
    },
    hostCwd: "/safe/pet",
    listWorkspaces: async () => [{ path: "/work/other", name: "Other" }],
    hostActions: {
      gatewayReply: async (payload) => {
        replies.push(payload);
        return {};
      },
    },
    worker: {
      requestWorker: async (_method, params) => {
        if (_method === "agent/goalGet")
          return {
            ok: true,
            result: options.goalState ?? {
              goal: task().objective,
              goalId: "original-goal",
              revision: 4,
              paused: false,
            },
          };
        paramsSeen.push(params);
        const profile = params.profileParams as {
          workspaces: Array<{ id: string }>;
          reusableSessions: Array<{ id: string; name: string }>;
        };
        const selected = profile.reusableSessions[0];
        const delegation: Record<string, unknown> = {
          workspaceId: profile.workspaces[0]?.id ?? "invalid",
          objective: "Continue with the remaining rows",
          ...(selected
            ? {
                reusableSessionId: selected.id,
                continuationEvidence: {
                  priorThread: selected.name,
                  reason: "Continue the same original objective using its verified source rows.",
                },
              }
            : {}),
        };
        options.mutate?.(delegation);
        return {
          ok: true,
          result: {
            text: "Continuation requested",
            extensions: {
              pet: {
                workDelegation: delegation,
                hostActions: [
                  { kind: "gatewayReply", payload: { text: "Continuation requested" } },
                ],
              },
            },
          },
        };
      },
    },
    startWorkSession: async (request) => {
      starts.push(request);
      if (options.launchError) throw new Error(options.launchError);
      return { sessionId: request.targetSessionId!, cwd: request.workspacePath! };
    },
  });
  return { service, starts, replies, paramsSeen };
}

test("closure retains original Session, full objective, checkpoint and Goal opt-in", async () => {
  for (const verificationMode of ["turn", "goal"] as const) {
    const h = harness();
    const original = task({ verificationMode });
    const result = await h.service.reportLongTaskClosure(original);
    expect(result).toMatchObject({
      continued: true,
      delegation: { sessionId: original.sessionId, reusedSession: true },
    });
    expect(h.starts).toHaveLength(1);
    expect(h.starts[0]).toMatchObject({
      targetSessionId: original.sessionId,
      workspacePath: original.workspacePath,
      originalObjective: original.objective,
      continuationDepth: 1,
    });
    expect(h.starts[0]!.task).toContain(original.objective);
    expect(h.starts[0]!.task).toContain(original.resultSummary!);
    expect(h.starts[0]!.goalObjective).toBe(
      verificationMode === "goal" ? original.objective : undefined,
    );
    expect(h.starts[0]!.goalContinuation).toEqual(
      verificationMode === "goal" ? { goalId: "original-goal", revision: 4 } : undefined,
    );
    const profile = h.paramsSeen[0]!.profileParams as {
      reusableSessions: unknown[];
      workspaces: unknown[];
    };
    expect(profile.reusableSessions).toHaveLength(1);
    expect(profile.reusableSessions[0]).toMatchObject({
      id: sessionSelectorId(original.sessionId),
    });
    expect(profile.workspaces).toHaveLength(1);
  }
});

test.each([
  { goal: null, paused: false },
  { goal: task().objective, goalId: "original-goal", revision: 4, paused: true },
  { goal: "New user objective", goalId: "replacement", revision: 1, paused: false },
])("closure never re-arms an ended, paused or replaced Goal: %j", async (goalState) => {
  const h = harness({ goalState });
  expect(
    (await h.service.reportLongTaskClosure(task({ verificationMode: "goal" }))).continued,
  ).toBe(false);
  expect(h.starts).toEqual([]);
});

test("a Goal changed during manager deliberation cannot launch a stale continuation", async () => {
  const goalState = { goal: task().objective, goalId: "original-goal", revision: 4, paused: false };
  const h = harness({
    goalState,
    mutate: () => {
      goalState.revision++;
    },
  });
  expect(
    (await h.service.reportLongTaskClosure(task({ verificationMode: "goal" }))).continued,
  ).toBe(false);
  expect(h.starts).toEqual([]);
});

test.each(["workspaceId", "reusableSessionId", "executionBackend"])(
  "closure rejects a changed %s",
  async (field) => {
    const h = harness({
      mutate: (delegation) => {
        delegation[field] = field === "executionBackend" ? "codex" : "foreign";
      },
    });
    const result = await h.service.reportLongTaskClosure(task());
    expect(result.continued).toBe(false);
    expect(result.delegationError).toBeDefined();
    expect(h.starts).toEqual([]);
  },
);

test("closure does not continue a busy Session", async () => {
  const h = harness({ busy: true });
  expect((await h.service.reportLongTaskClosure(task())).continued).toBe(false);
  expect(h.starts).toEqual([]);
});

test("invalid continuation corrects the actual Gateway reply", async () => {
  const h = harness({
    mutate: (delegation) => {
      delegation.workspaceId = "foreign";
    },
  });
  const result = await h.service.reportLongTaskClosure(
    task({ completionTarget: { kind: "im-gateway", channel: "wechat", target: "owner" } }),
  );
  expect(result.continued).toBe(false);
  expect(result.text).not.toContain("Continuation requested");
  expect(h.replies).toEqual([expect.objectContaining({ text: result.text })]);
  expect(h.starts).toEqual([]);
});

test("missing original Session produces the same failed reply on Gateway without replacement", async () => {
  const h = harness({ launchError: "Original Session does not exist" });
  const result = await h.service.reportLongTaskClosure(
    task({ completionTarget: { kind: "im-gateway", channel: "wechat", target: "owner" } }),
  );
  expect(result.continued).toBe(false);
  expect(h.starts).toHaveLength(1);
  expect(h.starts[0]!.targetSessionId).toBe("work-original");
  expect(result.text).toContain("Original Session does not exist");
  expect(result.text).not.toContain("Continuation requested");
  expect(h.replies).toEqual([expect.objectContaining({ text: result.text })]);
});

test("stale candidate title includes recent user objective and result, excluding injected messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "pet-recent-work-"));
  roots.push(root);
  const dir = join(root, "work-original");
  await mkdir(dir);
  await writeFile(
    join(dir, "transcript.jsonl"),
    [
      { role: "user", content: "Old first task" },
      { role: "user", content: "Check source table addresses and Star only verified targets" },
      { role: "assistant", content: "Rows 1–29 checked; remaining renames recorded" },
      { role: "user", content: "SYSTEM REPLACEMENT SHOULD NOT BE A USER REQUEST", injected: true },
    ]
      .map((data) => JSON.stringify({ type: "message", data }))
      .join("\n"),
  );
  let candidates: Array<{ name: string; description: string }> = [];
  const service = new PetDispatchService({
    metadata: { ensure: async () => ({ petSessionId: "mimi" }) },
    aggregator: {
      getSnapshot: () => ({
        version: 1,
        generation: 1,
        observedAt: 1,
        workerState: "active",
        sessions: [],
        pending: [],
      }),
      resolveNavigation: async () => ({ status: "not-found" }),
    },
    hostCwd: "/safe/pet",
    sessionsRootDir: root,
    listWorkspaces: async () => [{ path: "/work/original", name: "Original" }],
    listReusableSessions: async () => [
      {
        sessionId: "work-original",
        workspacePath: "/work/original",
        title: "Old first task",
        updatedAt: Date.now(),
      },
    ],
    worker: {
      requestWorker: async (_method, params) => {
        candidates = (params.profileParams as { reusableSessions: typeof candidates })
          .reusableSessions;
        return { ok: true, result: { text: "Read current context" } };
      },
    },
  });
  await service.dispatch({
    type: "chat",
    message: "Continue checking the table",
    clientMessageId: "one",
  });
  expect(candidates[0]!.name).toBe("Old first task");
  expect(candidates[0]!.description).toContain("Check source table addresses");
  expect(candidates[0]!.description).toContain("Rows 1–29 checked");
  expect(candidates[0]!.description).not.toContain("SYSTEM REPLACEMENT");
  expect(candidates[0]!.description).toContain("untrusted transcript excerpts");
});
