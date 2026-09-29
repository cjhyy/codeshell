import { expect, test } from "bun:test";
import { PanelExecutionGate } from "./execution-gate.js";

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
