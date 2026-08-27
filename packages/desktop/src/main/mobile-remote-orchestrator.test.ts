import { describe, expect, test } from "bun:test";
import { toMobileProjectMeta } from "./mobile-project-meta.js";
import { resolveMobileSessionCreateCwd } from "./mobile-remote/handle-client-event.js";

describe("mobile project projection", () => {
  test("includes V2 roots and keeps primary legacy fields", () => {
    expect(
      toMobileProjectMeta({
        id: "p1",
        name: "Project",
        roots: [
          { id: "r1", path: "/primary", name: "primary", addedAt: 1 },
          { id: "r2", path: "/secondary", name: "secondary", addedAt: 2 },
        ],
        primaryRootId: "r1",
        pinned: true,
        createdAt: 1,
        updatedAt: 2,
        lastOpenedAt: 2,
        revision: 2,
      }),
    ).toEqual({
      id: "p1",
      path: "/primary",
      name: "Project",
      addedAt: 1,
      pinned: true,
      primaryRootId: "r1",
      roots: [
        { id: "r1", path: "/primary", name: "primary", role: "primary" },
        { id: "r2", path: "/secondary", name: "secondary", role: "secondary" },
      ],
    });
  });
});

describe("mobile session.create cwd", () => {
  test("defaults to no-repo and rejects paths outside mounted roots", async () => {
    const allowed = async (cwd: string) => cwd === "/primary" || cwd === "/no-repo";
    expect(await resolveMobileSessionCreateCwd(undefined, allowed)).toBeNull();
    expect(await resolveMobileSessionCreateCwd(null, allowed)).toBeNull();
    expect(await resolveMobileSessionCreateCwd("/primary", allowed)).toBe("/primary");
    await expect(resolveMobileSessionCreateCwd("/unknown", allowed)).rejects.toThrow(
      /not a mounted project root/,
    );
  });
});
