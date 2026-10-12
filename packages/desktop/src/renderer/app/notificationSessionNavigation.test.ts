import { describe, expect, test } from "bun:test";
import type { SessionIndex } from "../../shared/session-catalog";
import type { DiskSessionMeta } from "../automation/rebuildFromDisk";
import { resolveNotificationSession } from "./notificationSessionNavigation";

const index = (id: string, engineSessionId = id, archived = false): SessionIndex => ({
  sessions: [{ id, engineSessionId, archived, title: "Conversation", createdAt: 1, updatedAt: 1 }],
  activeSessionId: null,
});
const disk = (id: string): DiskSessionMeta => ({
  id,
  engineSessionId: id,
  cwd: "/workspace/repo",
  title: "Disk conversation",
  updatedAt: 1,
  origin: "desktop",
});

describe("notification session resolution", () => {
  test("malformed event targets fail safely before touching session storage or metadata", async () => {
    const unexpected = () => {
      throw new Error("invalid target must not resolve");
    };
    for (const target of [null, undefined, 123, {}, [], "", "   "]) {
      expect(
        await resolveNotificationSession(target as string, {
          currentIndices: unexpected,
          persistedIndices: unexpected,
          listDiskSessions: unexpected,
        }),
      ).toBeNull();
    }
  });

  test("maps engine ids to existing local ids without querying native disk for external sessions", async () => {
    const indices = { project: index("local-id", "codex:external-session") };
    let diskCalls = 0;
    const deps = {
      currentIndices: () => indices,
      persistedIndices: () => indices,
      listDiskSessions: async () => {
        diskCalls += 1;
        return { sessions: [], nextCursor: null };
      },
    };
    expect(await resolveNotificationSession("codex:external-session", deps)).toEqual({
      kind: "indexed",
      target: { projectId: "project", session: indices.project.sessions[0] },
    });
    expect((await resolveNotificationSession("local-id", deps))?.kind).toBe("indexed");
    expect(diskCalls).toBe(0);
  });

  test("recovers fresh persisted indices and no-project ownership after renderer reload", async () => {
    const indices = { __no_repo__: index("local-id", "engine-id") };
    expect(
      await resolveNotificationSession("engine-id", {
        currentIndices: () => ({}),
        persistedIndices: () => indices,
      }),
    ).toEqual({
      kind: "indexed",
      target: { projectId: null, session: indices.__no_repo__.sessions[0] },
    });
  });

  test("refuses archived or recently deleted rows instead of selecting a blank draft", async () => {
    let diskCalls = 0;
    for (const persisted of [{}, { project: index("local-id", "engine-id", true) }]) {
      expect(
        await resolveNotificationSession("engine-id", {
          currentIndices: () => ({ project: index("local-id", "engine-id") }),
          persistedIndices: () => persisted,
          listDiskSessions: async () => {
            diskCalls += 1;
            return { sessions: [disk("engine-id")], nextCursor: null };
          },
        }),
      ).toBeNull();
    }
    expect(diskCalls).toBe(0);
  });

  test("pages metadata and imports only the existing matching top-level session", async () => {
    const calls: Array<{ limit: number; cursor?: string }> = [];
    const matching = disk("engine-id");
    const target = await resolveNotificationSession("engine-id", {
      currentIndices: () => ({}),
      persistedIndices: () => ({}),
      listDiskSessions: async (opts) => {
        calls.push(opts);
        return opts.cursor
          ? { sessions: [matching], nextCursor: null }
          : { sessions: [disk("other")], nextCursor: "older" };
      },
    });
    expect(target).toEqual({ kind: "disk", session: matching });
    expect(calls).toEqual([{ limit: 100 }, { limit: 100, cursor: "older" }]);
  });

  test("missing ids, child-only metadata and malformed pagination fail closed", async () => {
    for (const page of [
      { sessions: [], nextCursor: null },
      { sessions: [{ ...disk("engine-id"), parentSessionId: "parent" }], nextCursor: null },
      { sessions: [{ ...disk("engine-id"), origin: "subagent" as const }], nextCursor: null },
      { sessions: [], nextCursor: "repeated" },
    ]) {
      expect(
        await resolveNotificationSession("engine-id", {
          currentIndices: () => ({}),
          persistedIndices: () => ({}),
          listDiskSessions: async () => page,
        }),
      ).toBeNull();
    }
  });

  test("rechecks durable identity when indexing changes during the metadata request", async () => {
    let current: Record<string, SessionIndex> = {};
    let persisted: Record<string, SessionIndex> = {};
    expect(
      await resolveNotificationSession("engine-id", {
        currentIndices: () => current,
        persistedIndices: () => persisted,
        listDiskSessions: async () => {
          current = { project: index("original-local-id", "engine-id") };
          persisted = current;
          return { sessions: [disk("engine-id")], nextCursor: null };
        },
      }),
    ).toEqual({
      kind: "indexed",
      target: { projectId: "project", session: current.project!.sessions[0] },
    });

    current = {};
    persisted = {};
    expect(
      await resolveNotificationSession("engine-id", {
        currentIndices: () => current,
        persistedIndices: () => persisted,
        listDiskSessions: async () => {
          current = { project: index("deleted-local-id", "engine-id") };
          return { sessions: [disk("engine-id")], nextCursor: null };
        },
      }),
    ).toBeNull();
  });
});
