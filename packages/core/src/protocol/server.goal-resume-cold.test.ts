import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine, EngineResult } from "../engine/engine.js";
import { SessionManager } from "../session/session-manager.js";
import { ChatSessionManager, type EngineConfigSlice } from "./chat-session-manager.js";
import { AgentServer } from "./server.js";
import { Methods } from "./types.js";

function makeTransport() {
  const sent: any[] = [];
  let onMsg: (msg: unknown) => void = () => {};
  return {
    sent,
    deliver: (msg: unknown) => onMsg(msg),
    transport: {
      send: (message: unknown) => sent.push(message),
      onMessage: (callback: (msg: unknown) => void) => {
        onMsg = callback;
      },
      close: () => {},
    } as any,
  };
}

function result(sessionId: string): EngineResult {
  return {
    text: "resumed",
    reason: "completed",
    sessionId,
    turnCount: 1,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

async function waitFor(assertion: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("AgentServer cold Goal resume", () => {
  it("rehydrates and runs from ChatSessionManager's custom session storage root", async () => {
    const storageDir = mkdtempSync(join(tmpdir(), "goal-resume-custom-storage-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "goal-resume-project-"));
    tempDirs.push(storageDir, projectRoot);
    const sessionId = "cold-custom-goal";
    const persisted = new SessionManager(storageDir);
    const bundle = persisted.create(projectRoot, "test-model", "test-provider", sessionId);
    bundle.state.activeGoal = {
      objective: "resume from custom storage",
      goalId: "goal-cold",
      revision: 1,
      paused: true,
    };
    expect(persisted.saveState(bundle.state)).toBe(true);

    const factorySlices: Array<Partial<EngineConfigSlice>> = [];
    const restoredModels: string[] = [];
    const runs: Array<{ task: string; configuredCwd?: string; injected?: boolean }> = [];
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: (slice) => {
        factorySlices.push({ ...slice });
        const sessions = new SessionManager(storageDir);
        return {
          sessionExistsOnDisk: (id: string) => sessions.exists(id),
          getSessionManager: () => sessions,
          restoreSessionModel: (id: string) => restoredModels.push(id),
          getGoal: (id: string) => sessions.readActiveGoal(id),
          isHeadless: () => false,
          setAskUser() {},
          setBrowserBridge() {},
          setInjectCredential() {},
          setSessionMessageRouter() {},
          async run(task: string, opts: { injected?: boolean }): Promise<EngineResult> {
            runs.push({ task, configuredCwd: slice.cwd, injected: opts.injected });
            return result(sessionId);
          },
        } as unknown as Engine;
      },
    });
    const transport = makeTransport();
    const server = new AgentServer({
      transport: transport.transport,
      chatManager: manager,
      readActiveGoalFromDisk: (id) => persisted.readActiveGoal(id),
      updateActiveGoalOnDisk: (id, patch) => persisted.updateActiveGoal(id, patch)?.goal,
    });

    try {
      transport.deliver({
        jsonrpc: "2.0",
        id: "cold-resume",
        method: Methods.GoalUpdate,
        params: {
          sessionId,
          paused: false,
          expectedGoalId: "goal-cold",
          expectedRevision: 1,
        },
      });

      await waitFor(() => runs.length === 1, "cold Goal resume should run exactly once");

      expect(transport.sent.find((message) => message.id === "cold-resume")?.result).toEqual({
        ok: true,
        updated: true,
        goal: "resume from custom storage",
        goalId: "goal-cold",
        revision: 2,
        paused: false,
      });
      expect(factorySlices).toHaveLength(2);
      expect(factorySlices[0]?.cwd).toBeUndefined();
      expect(factorySlices[1]).toMatchObject({ cwd: projectRoot, projectTrusted: false });
      expect(restoredModels).toEqual([sessionId]);
      expect(runs).toEqual([
        {
          task: expect.stringContaining("读取当前持久目标"),
          configuredCwd: projectRoot,
          injected: true,
        },
      ]);
      const liveGoal = manager.get(sessionId)?.getGoal();
      expect(liveGoal).toMatchObject({
        goalId: "goal-cold",
        revision: 2,
      });
      expect(liveGoal?.paused).toBeUndefined();
    } finally {
      server.disconnect();
    }
  });
});
