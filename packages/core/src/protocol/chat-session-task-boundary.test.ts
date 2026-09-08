import { expect, test } from "bun:test";
import { ChatSession } from "./chat-session.js";
import type { Engine, EngineRunOptions } from "../engine/engine.js";

test("queued host tasks retain their original hard tool/Skill ceiling and ephemeral flag", async () => {
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const runs: EngineRunOptions[] = [];
  const engine = {
    run: async (_task: string, options: EngineRunOptions) => {
      runs.push(options);
      if (runs.length === 1) await gate;
      return {
        text: "done",
        reason: "completed",
        sessionId: "task",
        turnCount: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  } as unknown as Engine;
  const session = new ChatSession({ id: "task", engine });
  const first = session.enqueueTurn("hold", {});
  const tools = ["Write"];
  const skills = ["sample:setup"];
  const isolated = session.enqueueTurn("panel task", {
    behaviorMode: "isolatedTask",
    toolAllowlist: tools,
    skillAllowlist: skills,
    ephemeral: true,
  });
  tools.push("Bash");
  skills.push("other:secret");
  const empty = session.enqueueTurn("no tools", {
    toolAllowlist: [],
    skillAllowlist: [],
    ephemeral: false,
  });
  release();
  await Promise.all([first, isolated, empty]);
  expect(runs[1]).toMatchObject({
    behaviorMode: "isolatedTask",
    toolAllowlist: ["Write"],
    skillAllowlist: ["sample:setup"],
    ephemeral: true,
  });
  expect(runs[2]).toMatchObject({ toolAllowlist: [], skillAllowlist: [], ephemeral: false });
});
