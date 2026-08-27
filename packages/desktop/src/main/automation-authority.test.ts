import { describe, expect, test } from "bun:test";
import {
  resolveAutomationCreateAuthority,
  resolveAutomationUpdateAuthority,
} from "./automation-authority.js";

function deps() {
  return {
    requireRendererPath: async (cwd: string) => cwd,
    isNoRepoCwd: (cwd: string) => cwd === "/no-repo",
    resolveProjectRootById: (projectId: string, rootId?: string) => {
      if (projectId !== "project-1") throw new Error("project not found");
      if (rootId === "foreign") throw new Error("project root not found");
      const resolvedRootId = rootId ?? "root-primary";
      return {
        projectId,
        rootId: resolvedRootId,
        cwd: resolvedRootId === "root-secondary" ? "/secondary" : "/primary",
      };
    },
    resolveExactRoot: (cwd: string) =>
      cwd === "/primary"
        ? { projectId: "project-1", rootId: "root-primary", cwd: "/primary" }
        : undefined,
  };
}

describe("automation Main workspace authority", () => {
  test("new V2 jobs default to the current primary and reject renderer path mismatches", async () => {
    await expect(
      resolveAutomationCreateAuthority({ projectId: "project-1" }, deps()),
    ).resolves.toEqual({
      projectId: "project-1",
      rootId: "root-primary",
      cwd: "/primary",
    });
    await expect(
      resolveAutomationCreateAuthority(
        { projectId: "project-1", rootId: "root-secondary", cwd: "/forged" },
        deps(),
      ),
    ).rejects.toThrow(/does not match/i);
    await expect(
      resolveAutomationCreateAuthority(
        { projectId: "project-1", rootId: "foreign", cwd: "/primary" },
        deps(),
      ),
    ).rejects.toThrow(/root not found/);
  });

  test("old renderer cwd is upgraded when mounted and retained only for legacy paths", async () => {
    await expect(resolveAutomationCreateAuthority({ cwd: "/primary" }, deps())).resolves.toEqual({
      projectId: "project-1",
      rootId: "root-primary",
      cwd: "/primary",
    });
    await expect(resolveAutomationCreateAuthority({ cwd: "/legacy" }, deps())).resolves.toEqual({
      cwd: "/legacy",
    });
  });

  test("updates atomically rebind ids or explicitly clear to no-repo", async () => {
    await expect(
      resolveAutomationUpdateAuthority(
        { projectId: "project-1", rootId: "root-secondary" },
        deps(),
      ),
    ).resolves.toEqual({
      projectId: "project-1",
      rootId: "root-secondary",
      cwd: "/secondary",
    });
    await expect(
      resolveAutomationUpdateAuthority({ projectId: null, rootId: null, cwd: "" }, deps()),
    ).resolves.toEqual({ projectId: null, rootId: null, cwd: "" });
  });
});
