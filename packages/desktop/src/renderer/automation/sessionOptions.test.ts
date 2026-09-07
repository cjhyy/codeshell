import { describe, expect, it } from "bun:test";
import { NO_REPO_KEY, type SessionIndex, type SessionSummary } from "../transcripts";
import type { TrackedProject } from "../projects";
import type { DiskSessionMeta } from "./rebuildFromDisk";
import { buildAutomationConversations } from "./sessionOptions";

const projects: TrackedProject[] = [
  {
    id: "project-a",
    name: "alpha",
    displayName: "Alpha project",
    path: "/work/alpha",
    roots: [
      { id: "main", path: "/work/alpha", name: "alpha", addedAt: 1 },
      { id: "second", path: "/work/second", name: "second", addedAt: 1 },
    ],
    primaryRootId: "main",
    addedAt: 1,
  },
];

function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: `ui-${id}`,
    engineSessionId: id,
    title: `Conversation ${id}`,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function index(...sessions: SessionSummary[]): SessionIndex {
  return { sessions, activeSessionId: sessions[0]?.id ?? null };
}

function disk(id: string, overrides: Partial<DiskSessionMeta> = {}): DiskSessionMeta {
  return {
    id,
    engineSessionId: id,
    cwd: "/work/alpha",
    title: `Disk ${id}`,
    updatedAt: 3,
    origin: "desktop",
    ...overrides,
  };
}

describe("buildAutomationConversations", () => {
  it("includes normal chats and uses durable engine IDs while retaining local navigation", () => {
    const normal = session("engine-id");
    const automatic = session("automatic", { source: "automation", updatedAt: 1 });
    const options = buildAutomationConversations(
      { "project-a": index(normal, automatic) },
      [],
      projects,
    );
    expect(options.map((option) => option.sessionId)).toEqual(["engine-id", "automatic"]);
    expect(options[0]).toMatchObject({
      sessionId: "engine-id",
      session: normal,
      projectId: "project-a",
      projectLabel: "Alpha project",
      archived: false,
    });
    expect(options[0].session?.id).toBe("ui-engine-id");
    expect(options[0].disk).toBeUndefined();
  });

  it("omits empty drafts and never substitutes their UI ID for a missing engine binding", () => {
    const options = buildAutomationConversations(
      {
        [NO_REPO_KEY]: index(
          session("draft", { engineSessionId: undefined }),
          session("empty", { engineSessionId: "" }),
          session("blank", { engineSessionId: "   " }),
        ),
      },
      [],
      [],
    );
    expect(options).toEqual([]);
  });

  it("deduplicates engine IDs, keeps the latest local title, and sorts using disk recency", () => {
    const latest = session("same", { id: "new-ui", title: "My renamed chat", updatedAt: 5 });
    const options = buildAutomationConversations(
      {
        "project-a": index(session("same", { updatedAt: 1 }), session("other", { updatedAt: 8 })),
        [NO_REPO_KEY]: index(latest),
      },
      [disk("same", { updatedAt: 10 }), disk("same", { updatedAt: 9 })],
      projects,
    );
    expect(options.map((option) => option.sessionId)).toEqual(["same", "other"]);
    expect(options[0]).toMatchObject({
      title: "My renamed chat",
      updatedAt: 10,
      projectId: null,
      session: latest,
    });
    expect(options[0].disk).toBeUndefined();
    expect(latest.updatedAt).toBe(5);
  });

  it("keeps local archives out of the picker even if disk returns another copy", () => {
    const archived = session("archived", { archived: true });
    const indices = { "project-a": index(archived) };
    const onDisk = [disk("archived")];
    expect(buildAutomationConversations(indices, onDisk, projects)).toEqual([]);
    const lookup = buildAutomationConversations(indices, onDisk, projects, {
      includeArchived: true,
    });
    expect(lookup).toHaveLength(1);
    expect(lookup[0]).toMatchObject({ archived: true, session: archived });
  });

  it("honors archive tombstones without local engine IDs and durable disk archive timestamps", () => {
    const indices = {
      [NO_REPO_KEY]: index(
        session("old", { id: "legacy", engineSessionId: undefined, archived: true }),
      ),
    };
    const onDisk = [disk("legacy"), { ...disk("disk-archive"), archivedAt: 123 }];
    expect(buildAutomationConversations(indices, onDisk, projects)).toEqual([]);
    const lookup = buildAutomationConversations(indices, onDisk, projects, {
      includeArchived: true,
    });
    expect(lookup).toHaveLength(2);
    expect(lookup.every((option) => option.archived && option.disk)).toBe(true);
  });

  it("excludes subagents, parent-linked children and internal ephemeral IDs from both sources", () => {
    const indices = {
      "project-a": index(
        session("child"),
        session("legacy-child"),
        session("qchat-hidden"),
        session("panel-task-hidden"),
        session("regular"),
      ),
    };
    const options = buildAutomationConversations(
      indices,
      [
        disk("child", { origin: "subagent" }),
        disk("legacy-child", { parentSessionId: "parent" }),
        disk("qchat-disk"),
        disk("panel-task-disk"),
      ],
      projects,
      { includeArchived: true },
    );
    expect(options.map((option) => option.sessionId)).toEqual(["regular"]);
  });

  it("resolves mounted project roots and preserves a disk import target", () => {
    const onDisk = disk("mounted", { cwd: "/WORK/SECOND/" });
    const [option] = buildAutomationConversations({}, [onDisk], projects, {
      caseInsensitive: true,
    });
    expect(option).toMatchObject({
      projectId: "project-a",
      projectLabel: "Alpha project",
      sessionId: "mounted",
      disk: onDisk,
    });
    expect(option.session).toBeUndefined();
  });

  it("uses localized no-project/unknown labels, deleted project labels, or unmatched disk paths", () => {
    const options = buildAutomationConversations(
      {
        [NO_REPO_KEY]: index(session("chat")),
        removed: { ...index(session("removed")), deletedProjectLabel: "Former project" },
        missing: index(session("missing")),
      },
      [
        disk("scratch", { cwd: "/Users/example/.code-shell/no-repo" }),
        disk("elsewhere", { cwd: "/work/untracked" }),
      ],
      [],
      { noProjectLabel: "No project", unknownProjectLabel: "Unknown project" },
    );
    expect(
      Object.fromEntries(options.map((option) => [option.sessionId, option.projectLabel])),
    ).toEqual({
      chat: "No project",
      removed: "Former project",
      missing: "Unknown project",
      scratch: "No project",
      elsewhere: "/work/untracked",
    });
  });
});
