import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { INITIAL_STATE } from "./types";
import {
  applyTranscriptStreamEvent,
  archiveAllSessions,
  archiveSession,
  bucketKey,
  createSession,
  deleteSessionLocal,
  loadSessionIndex,
  loadTranscript,
  NO_REPO_KEY,
  projectBucketSegment,
  repoKeyOf,
  saveSessionIndex,
  saveTranscript,
  setActiveSession,
  setSessionWorkspaceProfileLocal,
} from "./transcripts";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "clear">;

function createStorage(): StorageLike {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
    clear: () => {
      items.clear();
    },
  };
}

describe("transcript snapshot cursor persistence", () => {
  const originalLocalStorage = globalThis.localStorage;
  let storage: StorageLike;

  beforeEach(() => {
    storage = createStorage();
    Object.defineProperty(globalThis, "localStorage", {
      value: storage,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: originalLocalStorage,
      configurable: true,
    });
  });

  it("round-trips snapshotSeq through saveTranscript/loadTranscript", () => {
    saveTranscript(null, "s1", {
      ...INITIAL_STATE,
      snapshotSeq: 42,
      messages: [{ kind: "assistant", id: "a1", text: "hi", done: true }],
    });

    expect(loadTranscript(null, "s1").snapshotSeq).toBe(42);
  });

  it("defaults legacy saved transcripts without snapshotSeq to 0", () => {
    storage.setItem(`codeshell.transcript.${NO_REPO_KEY}.legacy`, JSON.stringify({ messages: [] }));

    expect(loadTranscript(null, "legacy").snapshotSeq).toBe(0);
  });

  it("defaults legacy active goals without paused to running", () => {
    storage.setItem(
      `codeshell.transcript.${NO_REPO_KEY}.legacy-goal`,
      JSON.stringify({
        messages: [],
        activeGoal: { objective: "legacy", goalId: "goal-a", round: 2 },
      }),
    );

    expect(loadTranscript(null, "legacy-goal").activeGoal).toEqual({
      objective: "legacy",
      goalId: "goal-a",
      round: 2,
      paused: false,
    });
  });

  it("keeps no-project and conversation bucket strings byte-identical", () => {
    expect(NO_REPO_KEY).toBe("__no_repo__");
    expect(projectBucketSegment(null)).toBe("__no_repo__");
    expect(projectBucketSegment("stable-project-id")).toBe("stable-project-id");
    expect(repoKeyOf(null)).toBe("__no_repo__");
    expect(bucketKey(null, null)).toBe("__no_repo__::_none_");
    expect(bucketKey(null, "session-1")).toBe("__no_repo__::session-1");
    expect(bucketKey("stable-project-id", "session-1")).toBe("stable-project-id::session-1");
  });

  it("continues to read and write the legacy session-index and transcript keys", () => {
    const index = {
      sessions: [],
      activeSessionId: null,
    };
    storage.setItem("codeshell.sessionIndex.__no_repo__", JSON.stringify(index));

    expect(loadSessionIndex(null)).toEqual(index);

    saveSessionIndex("stable-project-id", index);
    saveTranscript("stable-project-id", "session-1", {
      ...INITIAL_STATE,
      messages: [],
    });

    expect(storage.getItem("codeshell.sessionIndex.stable-project-id")).toBe(JSON.stringify(index));
    expect(storage.getItem("codeshell.transcript.stable-project-id.session-1")).not.toBeNull();
    expect(storage.getItem("codeshell.projectSessionIndex.stable-project-id")).toBeNull();
    expect(storage.getItem("codeshell.projectTranscript.stable-project-id.session-1")).toBeNull();
  });

  it("normalizes a dangling persisted active session to draft", () => {
    storage.setItem(
      "codeshell.sessionIndex.repo-a",
      JSON.stringify({
        activeSessionId: "missing",
        sessions: [{ id: "live", title: "Live", createdAt: 1, updatedAt: 1 }],
      }),
    );

    expect(loadSessionIndex("repo-a").activeSessionId).toBeNull();
    expect(
      JSON.parse(storage.getItem("codeshell.sessionIndex.repo-a") ?? "{}").activeSessionId,
    ).toBeNull();
  });

  it("preserves an explicit draft when live sessions still exist", () => {
    storage.setItem(
      "codeshell.sessionIndex.repo-a",
      JSON.stringify({
        activeSessionId: null,
        sessions: [{ id: "live", title: "Live", createdAt: 1, updatedAt: 1 }],
      }),
    );

    expect(loadSessionIndex("repo-a").activeSessionId).toBeNull();
  });

  it("keeps a legacy index without an active field in draft", () => {
    storage.setItem(
      "codeshell.sessionIndex.repo-a",
      JSON.stringify({
        sessions: [{ id: "live", title: "Live", createdAt: 1, updatedAt: 1 }],
      }),
    );

    expect(loadSessionIndex("repo-a").activeSessionId).toBeNull();
  });

  it("normalizes an archived persisted active session to draft", () => {
    storage.setItem(
      "codeshell.sessionIndex.repo-a",
      JSON.stringify({
        activeSessionId: "archived",
        sessions: [
          { id: "archived", title: "Archived", createdAt: 1, updatedAt: 2, archived: true },
          { id: "live", title: "Live", createdAt: 1, updatedAt: 1 },
        ],
      }),
    );

    expect(loadSessionIndex("repo-a").activeSessionId).toBeNull();
  });

  it("deleting the active session enters draft instead of selecting an archived session", () => {
    saveSessionIndex("repo-a", {
      activeSessionId: "active",
      sessions: [
        { id: "active", title: "Active", createdAt: 1, updatedAt: 2 },
        { id: "archived", title: "Archived", createdAt: 1, updatedAt: 1, archived: true },
      ],
    });

    const next = deleteSessionLocal("repo-a", "active");

    expect(next.activeSessionId).toBeNull();
    expect(next.sessions.map((session) => session.id)).toEqual(["archived"]);
  });

  it("clears the active session when archiving it or archiving the whole project", () => {
    saveSessionIndex("repo-a", {
      activeSessionId: "active",
      sessions: [
        { id: "active", title: "Active", createdAt: 1, updatedAt: 2 },
        { id: "other", title: "Other", createdAt: 1, updatedAt: 1 },
      ],
    });

    expect(archiveSession("repo-a", "active", true).activeSessionId).toBeNull();

    setActiveSession("repo-a", "other");
    const archived = archiveAllSessions("repo-a", "Repo A");
    expect(archived.activeSessionId).toBeNull();
    expect(archived.sessions.every((session) => session.archived)).toBe(true);
  });

  it("refuses to activate archived or missing sessions", () => {
    saveSessionIndex("repo-a", {
      activeSessionId: null,
      sessions: [
        { id: "live", title: "Live", createdAt: 1, updatedAt: 2 },
        { id: "archived", title: "Archived", createdAt: 1, updatedAt: 1, archived: true },
      ],
    });

    expect(setActiveSession("repo-a", "archived").activeSessionId).toBeNull();
    expect(setActiveSession("repo-a", "missing").activeSessionId).toBeNull();
    expect(setActiveSession("repo-a", "live").activeSessionId).toBe("live");
  });

  it("creates a background session without replacing the active conversation", () => {
    saveSessionIndex("repo-a", {
      activeSessionId: "current",
      sessions: [{ id: "current", title: "Current", createdAt: 1, updatedAt: 1 }],
    });

    const created = createSession("repo-a", undefined, { activate: false });

    expect(created.sessionId).not.toBe("current");
    expect(created.index.activeSessionId).toBe("current");
    expect(created.index.sessions.map((session) => session.id)).toEqual([
      created.sessionId,
      "current",
    ]);
    expect(loadSessionIndex("repo-a").activeSessionId).toBe("current");
  });

  it("switches a Session digital human without replacing its history identity", () => {
    saveSessionIndex("repo-a", {
      activeSessionId: "work",
      sessions: [
        {
          id: "work",
          engineSessionId: "engine-work",
          title: "Checkout PRD",
          workspaceProfile: "product-manager",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    const next = setSessionWorkspaceProfileLocal("repo-a", "work", "ui-designer");

    expect(next.activeSessionId).toBe("work");
    expect(next.sessions[0]).toMatchObject({
      id: "work",
      engineSessionId: "engine-work",
      title: "Checkout PRD",
      workspaceProfile: "ui-designer",
    });
    expect(loadSessionIndex("repo-a").sessions[0]?.workspaceProfile).toBe("ui-designer");
  });

  it("hydrates context_transfer as a background package card", () => {
    const next = applyTranscriptStreamEvent(INITIAL_STATE, {
      type: "context_transfer",
      summary: "portable background",
      sourceSessionId: "source",
      fromEventId: "a",
      toEventId: "z",
      sourceEventCount: 12,
      estimatedTokens: 1500,
    });

    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]).toMatchObject({
      kind: "context_boundary",
      strategy: "summary",
      before: 0,
      after: 0,
      contextTransfer: {
        summary: "portable background",
        sourceSessionId: "source",
        fromEventId: "a",
        toEventId: "z",
        sourceEventCount: 12,
        estimatedTokens: 1500,
      },
    });
  });
});
