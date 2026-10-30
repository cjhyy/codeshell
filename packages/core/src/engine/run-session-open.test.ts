import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../session/session-manager.js";
import { openRunSession, type OpenRunSessionArgs } from "./run-session-open.js";

describe("run session identity claim", () => {
  it("updates accepted model metadata while duplicate inputs keep the previous execution identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "run-model-identity-"));
    const manager = new SessionManager(dir);
    const args: OpenRunSessionArgs = {
      sessionManager: manager,
      options: { sessionId: "owned-model-session", clientMessageId: "first" },
      parsedTask: { text: "owned", images: [], hasImages: false },
      taskText: "owned",
      userMessageContent: "owned",
      cwd: dir,
      sessionKind: "work",
      sessionWorkspaceProfile: undefined,
      llmModel: "model-a",
      llmProvider: "provider-a",
      isSubAgent: false,
      origin: undefined,
      costStore: undefined,
      cachedCompactedMessages: undefined,
      onAgentDirectionsDelivered: undefined,
    };
    try {
      expect(openRunSession(args).ok).toBe(true);
      args.options!.clientMessageId = "second";
      args.llmModel = "model-b";
      args.llmProvider = "provider-b";
      expect(openRunSession(args).ok).toBe(true);
      const before = manager.readSessionState("owned-model-session")!;
      expect(before).toMatchObject({ model: "model-b", provider: "provider-b", turnSeq: 2 });
      args.options!.clientMessageId = "first";
      args.llmModel = "must-not-apply";
      expect(openRunSession(args).ok).toBe(false);
      expect(manager.readSessionState("owned-model-session")).toEqual(before);
      expect(
        manager
          .resumeForRun("owned-model-session")
          .transcript.getEvents("message")
          .filter((event) => event.data.role === "user"),
      ).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
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
