import { describe, it, expect } from "bun:test";
import { ChatSession } from "./chat-session.js";
import type { Engine, EngineResult } from "../engine/engine.js";

/**
 * A2: model switch must be per-session and must not mutate the model mid-run.
 * ChatSession.requestModelSwitch applies immediately when idle; when a turn is
 * in flight it defers to the next run boundary (mirrors planMode/permissionMode
 * per-session handling and the "don't change the model under a running client"
 * rule from the session-isolation research).
 */
function fakeEngine(): { engine: Engine; switched: string[]; release: () => void; runStarted: Promise<void> } {
  const switched: string[] = [];
  let releaseRun!: () => void;
  let signalStarted!: () => void;
  const runStarted = new Promise<void>((r) => (signalStarted = r));
  const gate = new Promise<void>((r) => (releaseRun = r));

  const engine = {
    switchModel(key: string) {
      switched.push(key);
      return { key, model: key } as never;
    },
    async run(): Promise<EngineResult> {
      signalStarted();
      await gate; // hold the turn open until the test releases it
      return {
        text: "ok",
        reason: "completed",
        sessionId: "s",
        turnCount: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  } as unknown as Engine;

  return { engine, switched, release: releaseRun, runStarted };
}

describe("ChatSession.requestModelSwitch", () => {
  it("applies immediately when the session is idle", () => {
    const { engine, switched } = fakeEngine();
    const session = new ChatSession({ id: "s", engine });
    session.requestModelSwitch("haiku");
    expect(switched).toEqual(["haiku"]);
  });

  it("defers the switch until the run boundary when a turn is in flight", async () => {
    const { engine, switched, release, runStarted } = fakeEngine();
    const session = new ChatSession({ id: "s", engine });

    const turn = session.enqueueTurn("do work", {});
    await runStarted; // turn is now mid-run

    // Switch requested mid-run: must NOT apply yet.
    session.requestModelSwitch("gpt");
    expect(switched).toEqual([]);

    release(); // let the turn finish
    await turn;

    // Applied at the run boundary.
    expect(switched).toEqual(["gpt"]);
  });
});
