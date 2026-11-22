import { expect, test } from "bun:test";
import type { BrowserWindow } from "electron";
import type {
  ExternalRuntimeService,
  ExternalRuntimeStartRequest,
} from "../external-runtime-service.js";
import type { CallShellBusiness } from "../../shared/shell-business-contracts.js";
import { nativeExternalGoals } from "./external-goals.js";

const window = { isDestroyed: () => false } as BrowserWindow;

test("a reloaded workbench never receives the stored goal or starts a cold external runtime", async () => {
  const doc = new AbortController();
  const stored = Promise.withResolvers<unknown>();
  const entered = Promise.withResolvers<void>();
  const calls: string[] = [];
  const runtime = {
    get: () => undefined,
    ensure: () => {
      calls.push("ensure");
    },
  };
  let release = 0;
  const handle = nativeExternalGoals({
    window: () => window,
    ownsMimiDocument: () => false,
    documentSignal: () => doc.signal,
    watchOwner: () => ({
      signal: new AbortController().signal,
      release: () => {
        release++;
      },
    }),
    call: (async (method) => {
      calls.push(method);
      entered.resolve();
      return stored.promise;
    }) as CallShellBusiness,
    runtime: () => runtime as unknown as ExternalRuntimeService,
    hasWorker: () => false,
    onGoalRead: () => calls.push("notice"),
  });
  const pending = handle({ id: "read", method: "agent/goalGet", params: { sessionId: "cold" } }, 7);
  await entered.promise;
  doc.abort(Error("Reload"));
  stored.resolve({ external: true, goal: { goal: "fixture" } });
  await expect(pending).rejects.toThrow("Reload");
  expect(calls).toEqual(["goals/read"]);
  expect(release).toBe(1);
});

test("a changed project or Session during persisted Goal resume prevents the provider launch", async () => {
  for (const changed of [
    { identity: "new-generation", projectBound: true },
    { identity: "old", projectBound: false },
  ]) {
    const signal = new AbortController().signal;
    const runtime = {
      get: () => undefined,
      canResumeGoal: () => false,
      async ensure(request: ExternalRuntimeStartRequest) {
        await request.refreshStartAuthority!();
        throw Error("Unexpected provider launch");
      },
      updateGoal: () => {
        throw Error("Unexpected Goal mutation");
      },
      deleteGoal: () => {},
      extendGoal: () => {},
    };
    let reads = 0;
    const handle = nativeExternalGoals({
      window: () => window,
      ownsMimiDocument: () => false,
      documentSignal: () => signal,
      watchOwner: () => ({ signal, release: () => {} }),
      runtime: () => runtime as unknown as ExternalRuntimeService,
      call: (async (method) => {
        if (method === "goals/read")
          return { external: true, goal: { goalId: "goal", revision: 1 } };
        if (method !== "goals/resume") throw Error("Unexpected Goal read");
        reads++;
        return {
          modelKey: "claude-code/fixture",
          cwd: "/fixture",
          mainRoot: "/fixture",
          ...(reads === 1 ? { identity: "old", projectBound: true } : changed),
        };
      }) as CallShellBusiness,
      hasWorker: () => false,
      onGoalRead: () => {},
    });
    const result = await handle(
      {
        id: "resume",
        method: "agent/goalUpdate",
        params: {
          sessionId: "fixture",
          expectedGoalId: "goal",
          expectedRevision: 1,
          paused: false,
        },
      },
      7,
    );
    expect(result).toMatchObject({
      error: { message: "External goal Session changed before startup" },
    });
    expect(reads).toBe(2);
  }
});
