import { expect, test } from "bun:test";
import { PanelExecutionBusyError, PanelExecutionGate } from "./execution-gate.js";

const scope = { appId: "fixture", projectPath: "/project" };
const matches = (value: typeof scope) =>
  value.appId === scope.appId && value.projectPath === scope.projectPath;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("admission is synchronous, rejects overlapping mutations and releases after failed writes", async () => {
  const gate = new PanelExecutionGate();
  const pending = deferred();
  const writing = gate.mutate(matches, async () => {
    await pending.promise;
    throw new Error("write failed");
  });
  expect(() => gate.enter(scope)).toThrow("正在更新");
  await expect(gate.mutate(matches, async () => {})).rejects.toThrow("修改正在进行");
  const releaseOther = gate.enter({ ...scope, projectPath: "/other" });
  releaseOther();
  pending.resolve();
  await expect(writing).rejects.toThrow("write failed");
  const release = gate.enter(scope);
  await expect(gate.mutate(matches, async () => {})).rejects.toThrow("正在提交");
  release();
  release();
  await gate.mutate(matches, async () => {});
});

test("execution stays occupied while its promise settles, including failed preparation", async () => {
  const gate = new PanelExecutionGate();
  const pending = deferred();
  const running = gate.run(scope, async () => {
    await pending.promise;
    throw new Error("preparation failed");
  });
  await expect(gate.mutate(matches, async () => {})).rejects.toThrow("正在提交");
  pending.resolve();
  await expect(running).rejects.toThrow("preparation failed");
  await gate.mutate(matches, async () => {});
});

test("paused durable work and terminal cleanup remain occupied through registered activity", async () => {
  const gate = new PanelExecutionGate();
  const queued = [scope];
  const unregister = gate.register(() => queued);
  await expect(gate.mutate(matches, async () => {})).rejects.toThrow("排队");
  queued.splice(0);
  await gate.mutate(matches, async () => {});
  unregister();
});

test("a refused mutation reports who holds the panel, grouped by holder and project", async () => {
  const gate = new PanelExecutionGate();
  const call = { ...scope, holder: { kind: "panel-call" as const, guestId: 7 } };
  const releaseFirst = gate.enter(call);
  const releaseSecond = gate.enter(call);
  const releaseOther = gate.enter({
    ...scope,
    projectPath: "/other",
    holder: { kind: "panel-call", guestId: 9 },
  });
  const unregister = gate.register(() => [
    { ...scope, holder: { kind: "tool-job" as const, label: "editor-runtime" } },
  ]);
  const error = await gate.mutate(matches, async () => {}).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(PanelExecutionBusyError);
  const expected = [
    {
      appId: "fixture",
      projectPath: "/project",
      holder: { kind: "panel-call", guestId: 7 },
      count: 2,
    },
    {
      appId: "fixture",
      projectPath: "/project",
      holder: { kind: "tool-job", label: "editor-runtime" },
      count: 1,
    },
  ];
  expect((error as PanelExecutionBusyError).blockers).toEqual(expected);
  // The same read-only snapshot is available before deciding to close them.
  expect(gate.blockers(matches)).toEqual(expected);
  releaseFirst();
  releaseSecond();
  releaseOther();
  unregister();
  expect(gate.blockers(matches)).toEqual([]);
});
