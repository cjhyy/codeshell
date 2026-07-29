import { describe, expect, test } from "bun:test";
import {
  compactSidebarSessions,
  revealSidebarProject,
  sortSidebarSessions,
} from "./sidebarSessionVisibility";

const sessions = Array.from({ length: 8 }, (_, index) => ({ id: `session-${index + 1}` }));

describe("sidebar session visibility", () => {
  test("keeps pinned Sessions ahead of newer unpinned Sessions", () => {
    const ordered = sortSidebarSessions([
      { id: "new", updatedAt: 30 },
      { id: "pinned-old", updatedAt: 10, pinned: true },
      { id: "pinned-new", updatedAt: 20, pinned: true },
      { id: "middle", updatedAt: 25 },
    ]);

    expect(ordered.map((session) => session.id)).toEqual([
      "pinned-new",
      "pinned-old",
      "new",
      "middle",
    ]);
  });

  test("keeps an externally selected session visible inside the compact five-row list", () => {
    expect(
      compactSidebarSessions(sessions, "session-8", false, 5).map((session) => session.id),
    ).toEqual(["session-1", "session-2", "session-3", "session-4", "session-8"]);
    expect(compactSidebarSessions(sessions, "session-3", false, 5)).toEqual(sessions.slice(0, 5));
    expect(compactSidebarSessions(sessions, "session-8", true, 5)).toEqual(sessions);
  });

  test("opens the selected project without changing unrelated collapsed projects", () => {
    const collapsed = new Set(["project-a", "project-b"]);
    expect([...revealSidebarProject(collapsed, "project-a")]).toEqual(["project-b"]);
    expect(revealSidebarProject(collapsed, null)).toBe(collapsed);
  });
});

describe("compactSidebarSessions expanded cap", () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ id: `s-${i}` }));

  test("expanding without a cap still returns everything (unchanged default)", () => {
    expect(compactSidebarSessions(many, null, true, 5)).toHaveLength(500);
  });

  test("expanding with a cap renders one page, not ~500 rows", () => {
    // Rendering every Session at once — each firing a workspace IPC — is what
    // froze the sidebar on a project with ~1000 Sessions.
    expect(compactSidebarSessions(many, null, true, 5, 60)).toHaveLength(60);
  });

  test("the active Session stays visible past the cap", () => {
    const result = compactSidebarSessions(many, "s-400", true, 5, 60);
    expect(result).toHaveLength(60);
    expect(result.some((s) => s.id === "s-400")).toBe(true);
  });

  test("a cap larger than the list is a no-op", () => {
    expect(compactSidebarSessions(many.slice(0, 10), null, true, 5, 60)).toHaveLength(10);
  });
});
