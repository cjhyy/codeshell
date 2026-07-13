import { describe, expect, test } from "bun:test";
import { compactSidebarSessions, revealSidebarProject } from "./sidebarSessionVisibility";

const sessions = Array.from({ length: 8 }, (_, index) => ({ id: `session-${index + 1}` }));

describe("sidebar session visibility", () => {
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
