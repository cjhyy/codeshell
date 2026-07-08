import { describe, expect, spyOn, test } from "bun:test";
import {
  engineSessionIdsForWorkspaceRelease,
  releaseWorkspaceForArchive,
  releaseWorkspacesForArchiveMany,
} from "./workspaceArchiveRelease";
import type { SessionSummary } from "./transcripts";

function summary(id: string, engineSessionId?: string, archived = false): SessionSummary {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 2,
    ...(engineSessionId ? { engineSessionId } : {}),
    ...(archived ? { archived: true } : {}),
  };
}

describe("workspace archive release helpers", () => {
  test("resolves engineSessionId before local UI id", () => {
    expect(
      engineSessionIdsForWorkspaceRelease([
        summary("ui-1", "engine-1"),
        summary("ui-2"),
        summary("ui-3", "engine-1"),
      ]),
    ).toEqual(["engine-1", "ui-2"]);
  });

  test("single archive releases before marking archived", async () => {
    const calls: string[] = [];
    await releaseWorkspaceForArchive(summary("ui-1", "engine-1"), true, {
      releaseSessionWorkspace: async (sessionId) => {
        calls.push(sessionId);
      },
      releaseManySessionWorkspaces: async () => {
        throw new Error("not used");
      },
    });
    expect(calls).toEqual(["engine-1"]);
  });

  test("unknown release result is logged and does not block single archive", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const steps: string[] = [];
    try {
      await releaseWorkspaceForArchive(summary("ui-1", "missing-engine"), true, {
        releaseSessionWorkspace: async (sessionId) => {
          steps.push(`release:${sessionId}`);
          return { sessionId, ok: true, status: "missing", reason: "unknown session" };
        },
        releaseManySessionWorkspaces: async () => {
          throw new Error("not used");
        },
      });
      steps.push("archive");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }

    expect(steps).toEqual(["release:missing-engine", "archive"]);
  });

  test("restore does not release a workspace", async () => {
    const calls: string[] = [];
    await releaseWorkspaceForArchive(summary("ui-1", "engine-1"), false, {
      releaseSessionWorkspace: async (sessionId) => {
        calls.push(sessionId);
      },
      releaseManySessionWorkspaces: async () => {
        throw new Error("not used");
      },
    });
    expect(calls).toEqual([]);
  });

  test("archive-all and project-delete use releaseMany for unarchived sessions", async () => {
    const calls: string[][] = [];
    await releaseWorkspacesForArchiveMany(
      [summary("ui-1", "engine-1"), summary("ui-2"), summary("ui-3", "engine-3", true)],
      {
        releaseSessionWorkspace: async () => {
          throw new Error("not used");
        },
        releaseManySessionWorkspaces: async (sessionIds) => {
          calls.push(sessionIds);
        },
      },
    );
    expect(calls).toEqual([["engine-1", "ui-2"]]);
  });

  test("releaseMany mixed valid and missing results do not block archiving all", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const steps: string[] = [];
    try {
      await releaseWorkspacesForArchiveMany([summary("ui-1", "engine-1"), summary("ui-2")], {
        releaseSessionWorkspace: async () => {
          throw new Error("not used");
        },
        releaseManySessionWorkspaces: async (sessionIds) => {
          steps.push(`release:${sessionIds.join(",")}`);
          return [
            {
              sessionId: "engine-1",
              ok: true,
              status: "released",
              workspace: { root: "/repo", kind: "main" },
            },
            { sessionId: "ui-2", ok: true, status: "missing", reason: "unknown session" },
          ];
        },
      });
      steps.push("archive-all");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }

    expect(steps).toEqual(["release:engine-1,ui-2", "archive-all"]);
  });

  test("release rejection stays visible but does not block archive", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const steps: string[] = [];
    try {
      await releaseWorkspaceForArchive(summary("ui-1", "engine-1"), true, {
        releaseSessionWorkspace: async () => {
          steps.push("release");
          throw new Error("worker release timed out");
        },
        releaseManySessionWorkspaces: async () => {
          throw new Error("not used");
        },
      });
      steps.push("archive");
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }

    expect(steps).toEqual(["release", "archive"]);
  });

  test("releaseMany is skipped when there are no live sessions to archive", async () => {
    const calls: string[][] = [];
    await releaseWorkspacesForArchiveMany([summary("ui-1", "engine-1", true)], {
      releaseSessionWorkspace: async () => {
        throw new Error("not used");
      },
      releaseManySessionWorkspaces: async (sessionIds) => {
        calls.push(sessionIds);
      },
    });
    expect(calls).toEqual([]);
  });
});
