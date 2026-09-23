import { expect, test } from "bun:test";
import { panelExecutionGate } from "./execution-gate.js";
import { PanelAppAgentTaskService, type PanelAgentTaskOwner } from "./agent-task-service.js";

test("Agent task holds package until session cleanup, even with broken viewers", async () => {
  const owner: PanelAgentTaskOwner = {
    guestId: 1,
    ownerWebContentsId: 1,
    appId: "task-lease",
    appTitle: "Task lease",
    projectPath: "/agent-task-lease",
    cwd: "/agent-task-lease",
    bucket: "test",
    availableSkills: [],
  };
  let finish!: () => void;
  let closed!: () => void;
  let closing = false;
  const ran = new Promise<void>((done) => {
    finish = done;
  });
  const cleanup = new Promise<void>((done) => {
    closed = done;
  });
  const service = new PanelAppAgentTaskService(
    {
      run: async () => {
        await ran;
        return { text: "done" };
      },
      cancel: async () => {},
      rebind: () => {},
      close: async () => {
        closing = true;
        await cleanup;
      },
    },
    () => {
      throw new Error("viewer gone");
    },
  );
  const mutate = () =>
    panelExecutionGate.mutate(
      (scope) => scope.appId === owner.appId,
      async () => {},
    );
  const started = service.start(owner, { prompt: "work", label: "Work" });
  try {
    await expect(mutate()).rejects.toThrow("正在提交");
    finish();
    await new Promise((done) => setTimeout(done, 0));
    expect(closing).toBe(true);
    expect(service.get(owner, started.id).status).toBe("completed");
    await expect(mutate()).rejects.toThrow("正在提交");
  } finally {
    finish();
    closed();
  }
  await new Promise((done) => setTimeout(done, 0));
  await panelExecutionGate.mutate(
    (scope) => scope.appId === owner.appId,
    async () => {
      expect(() => service.start(owner, { prompt: "work again", label: "Work" })).toThrow(
        "正在更新",
      );
    },
  );
});
