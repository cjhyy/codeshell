import { describe, expect, test } from "bun:test";
import { resolveRendererConfigurationTarget } from "./renderer-configuration-authority.js";

const deps = {
  resolveProjectPrimary: async (projectId: unknown) => {
    if (projectId !== "project-1") throw new Error("project not found");
    return {
      project: { id: "project-1" },
      root: { id: "root-primary" },
      rootId: "root-primary",
      path: "/primary",
    };
  },
  resolveSessionAuthority: async (sessionId: string) => {
    if (sessionId !== "old-session") throw new Error("unknown session");
    return {
      workspace: { root: "/old-worktree", kind: "worktree" as const },
      projectId: "project-1",
      mainRootId: "root-old",
      mainRoot: "/old-main",
      mainRootName: "old-main",
      rootStatus: "ok" as const,
    };
  },
  requireUsableSessionAuthority: (authority: { rootStatus: string }) => {
    if (authority.rootStatus !== "ok") throw new Error("unusable Session root");
  },
  resolveNoRepoCwd: () => "/main-owned-no-repo",
};

describe("renderer configuration authority", () => {
  test("project targets resolve only the current primary and Session targets keep their main root", async () => {
    await expect(
      resolveRendererConfigurationTarget({ projectId: "project-1" }, deps),
    ).resolves.toEqual({
      kind: "project",
      projectId: "project-1",
      mainRootId: "root-primary",
      cwd: "/primary",
    });
    await expect(
      resolveRendererConfigurationTarget({ sessionId: "old-session" }, deps),
    ).resolves.toEqual({
      kind: "session",
      projectId: "project-1",
      sessionId: "old-session",
      mainRootId: "root-old",
      cwd: "/old-main",
    });
    await expect(resolveRendererConfigurationTarget({ noRepo: true }, deps)).resolves.toEqual({
      kind: "no-repo",
      cwd: "/main-owned-no-repo",
    });
  });

  test("hostile renderer cannot reach any configuration surface with paths or forged identities", async () => {
    const surfaces = [
      "settings:read/write",
      "skills:discover/read/write",
      "profiles:discover/read/write",
      "capabilities:discover/read/write",
      "plugins:discover",
      "plugin-commands:discover",
      "agents:discover/read/write",
    ];
    const hostile: unknown[] = [
      "/secondary",
      { cwd: "/secondary" },
      { projectId: "project-1", cwd: "/secondary" },
      { projectId: "project-1", rootId: "root-secondary" },
      { projectId: "project-1", sessionId: "old-session" },
      { sessionId: "old-session", mainRootId: "root-old" },
      { noRepo: true, cwd: "/secondary" },
      { projectId: "forged-project" },
      { sessionId: "forged-session" },
      null,
    ];

    const reached: string[] = [];
    for (const surface of surfaces) {
      for (const input of hostile) {
        await expect(
          resolveRendererConfigurationTarget(input, deps).then(() => reached.push(surface)),
        ).rejects.toThrow();
      }
    }
    expect(reached).toEqual([]);
  });

  test("every renderer configuration surface receives only the Main-resolved root", async () => {
    const surfaces = [
      "settings",
      "skills",
      "profiles",
      "capabilities",
      "plugins",
      "plugin-commands",
      "agents",
    ];
    const observed: string[] = [];
    for (const _surface of surfaces) {
      const resolved = await resolveRendererConfigurationTarget({ projectId: "project-1" }, deps);
      observed.push(resolved.cwd);
    }
    expect(observed).toEqual(surfaces.map(() => "/primary"));
    expect(observed).not.toContain("/secondary");
  });
});
