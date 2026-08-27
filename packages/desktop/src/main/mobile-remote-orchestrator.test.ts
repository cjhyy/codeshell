import { describe, expect, test } from "bun:test";
import { toMobileProjectMeta } from "./mobile-project-meta.js";
import {
  resolveMobileSessionCreateCwd,
  resolveMobileSessionCreateTarget,
} from "./mobile-remote/handle-client-event.js";

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

  test("resolves V2 ids authoritatively and keeps explicit no-repo distinct from legacy cwd", async () => {
    const resolveProjectRoot = (projectId: string, rootId?: string) => {
      if (projectId !== "p1") throw new Error("project not found");
      if (rootId === "foreign" || rootId === "removed") throw new Error("project root not found");
      if (rootId === "missing") throw new Error("project root directory is missing");
      return {
        projectId,
        rootId: rootId ?? "r-primary",
        cwd: rootId === "r-secondary" ? "/secondary" : "/primary",
      };
    };
    const legacyAllowed = async (cwd: string) => cwd === "/primary" || cwd === "/no-repo";

    await expect(
      resolveMobileSessionCreateTarget(
        { type: "session.create", projectId: "p1", rootId: "r-secondary", cwd: "/forged" },
        { resolveProjectRoot, isLegacyCwdAllowed: legacyAllowed },
      ),
    ).resolves.toEqual({ projectId: "p1", rootId: "r-secondary", cwd: "/secondary" });
    await expect(
      resolveMobileSessionCreateTarget(
        { type: "session.create", projectId: "unknown" },
        { resolveProjectRoot, isLegacyCwdAllowed: legacyAllowed },
      ),
    ).rejects.toThrow(/project not found/);
    await expect(
      resolveMobileSessionCreateTarget(
        { type: "session.create", projectId: "p1", rootId: "foreign" },
        { resolveProjectRoot, isLegacyCwdAllowed: legacyAllowed },
      ),
    ).rejects.toThrow(/root not found/);
    await expect(
      resolveMobileSessionCreateTarget(
        { type: "session.create", projectId: "p1", rootId: "missing" },
        { resolveProjectRoot, isLegacyCwdAllowed: legacyAllowed },
      ),
    ).rejects.toThrow(/directory is missing/);
    await expect(
      resolveMobileSessionCreateTarget(
        { type: "session.create", projectId: null },
        { resolveProjectRoot, isLegacyCwdAllowed: legacyAllowed },
      ),
    ).resolves.toEqual({ projectId: null, cwd: null });
    await expect(
      resolveMobileSessionCreateTarget(
        { type: "session.create", cwd: "/primary" },
        { resolveProjectRoot, isLegacyCwdAllowed: legacyAllowed },
      ),
    ).resolves.toEqual({ cwd: "/primary" });
    await expect(
      resolveMobileSessionCreateTarget(
        { type: "session.create", rootId: "r-secondary" },
        { resolveProjectRoot, isLegacyCwdAllowed: legacyAllowed },
      ),
    ).rejects.toThrow(/requires projectId/);
  });
});
