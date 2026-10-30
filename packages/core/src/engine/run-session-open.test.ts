import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../session/session-manager.js";
import { openRunSession, type OpenRunSessionArgs } from "./run-session-open.js";

describe("run session identity claim", () => {
  it("links an opener with an old resume snapshot to the run it actually replaces", () => {
    const dir = mkdtempSync(join(tmpdir(), "run-session-open-"));
    const manager = new SessionManager(dir);
    const args: OpenRunSessionArgs = {
      sessionManager: manager,
      options: { sessionId: "shared" },
      parsedTask: { text: "work", images: [], hasImages: false },
      taskText: "work",
      userMessageContent: "work",
      cwd: dir,
      sessionKind: "work",
      sessionWorkspaceProfile: undefined,
      llmModel: "test",
      llmProvider: "test",
      isSubAgent: false,
      origin: undefined,
      costStore: undefined,
      cachedCompactedMessages: undefined,
      onAgentDirectionsDelivered: undefined,
    };
    const open = () => {
      const result = openRunSession(args);
      if (!result.ok) throw new Error("run was not opened");
      return result.opened;
    };
    try {
      const initial = open();
      const stale = manager.resumeForRun("shared");
      const competing = open();
      // Represents process A returning from its transcript load after process B
      // has already claimed the next run in the same durable Session.
      manager.resumeForRun = () => stale;
      const latest = open();
      expect(latest.previousRunId).toBe(competing.runId);
      expect(latest.previousRunId).not.toBe(initial.runId);
      expect(manager.readSessionState("shared")).toMatchObject({
        runId: latest.runId,
        status: "active",
        turnSeq: 3,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recomputes the predecessor when a competing opener wins the first CAS", () => {
    const dir = mkdtempSync(join(tmpdir(), "run-session-cas-"));
    const manager = new SessionManager(dir);
    const competitor = new SessionManager(dir);
    const { state } = manager.create(dir, "test", "test", "shared");
    try {
      manager.startSessionRun(state, "initial", "initial-client");
      const originalSave = (manager as any).saveStateAttempt.bind(manager);
      let injected = false;
      (manager as any).saveStateAttempt = (incoming: typeof state) => {
        if (!injected) {
          injected = true;
          competitor.startSessionRun(competitor.resumeForRun("shared").state, "competing");
        }
        return originalSave(incoming);
      };
      expect(manager.startSessionRun(state, "latest", "latest-client")).toBe("competing");
      expect(state).toMatchObject({
        runId: "latest",
        clientMessageId: "latest-client",
        turnSeq: 3,
      });
      expect(manager.readSessionState("shared")).toMatchObject({
        runId: "latest",
        clientMessageId: "latest-client",
        turnSeq: 3,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
