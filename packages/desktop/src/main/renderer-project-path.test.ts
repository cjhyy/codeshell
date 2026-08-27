import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  requireRendererProject,
  requireRendererProjectEntryPath,
  requireRendererProjectPath,
  requireRendererProjectPathOrGlobal,
  requireRendererProjectRoot,
  requireRendererProjectRootEntry,
} from "./renderer-project-path.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project-id renderer authorization", () => {
  test("resolves only live project and root ids from the main-owned registry", async () => {
    const { root, project } = await fixture();
    const secondary = join(root, "secondary");
    await mkdir(secondary);
    const projects = [
      {
        id: "project-1",
        name: "Project",
        roots: [
          { id: "primary", path: project, name: "project", addedAt: 1 },
          { id: "secondary", path: secondary, name: "secondary", addedAt: 2 },
        ],
        primaryRootId: "primary",
        createdAt: 1,
        updatedAt: 1,
        lastOpenedAt: 1,
        revision: 1,
      },
    ];

    await expect(requireRendererProject("project-1", { projects })).resolves.toMatchObject({
      id: "project-1",
    });
    await expect(
      requireRendererProjectRoot("project-1", "secondary", { projects }),
    ).resolves.toMatchObject({ rootId: "secondary", path: await realpath(secondary) });
    await expect(requireRendererProject("unknown", { projects })).rejects.toThrow(/not found/);
    await expect(
      requireRendererProjectRoot("project-1", "unknown", { projects }),
    ).rejects.toThrow(/root not found/);
  });

  test("maps a real entry to its root and rejects traversal and symlink escapes", async () => {
    const { root, project } = await fixture();
    const secondary = join(root, "secondary");
    const outside = join(root, "outside.txt");
    const inside = join(secondary, "inside.txt");
    await mkdir(secondary);
    await writeFile(inside, "inside");
    await writeFile(outside, "outside");
    const projects = [
      {
        id: "project-1",
        name: "Project",
        roots: [
          { id: "primary", path: project, name: "project", addedAt: 1 },
          { id: "secondary", path: secondary, name: "secondary", addedAt: 2 },
        ],
        primaryRootId: "primary",
        createdAt: 1,
        updatedAt: 1,
        lastOpenedAt: 1,
        revision: 1,
      },
    ];

    await expect(
      requireRendererProjectRootEntry("project-1", inside, { projects }),
    ).resolves.toEqual({ entry: await realpath(inside), rootId: "secondary" });
    await expect(
      requireRendererProjectRootEntry("project-1", outside, { projects }),
    ).rejects.toThrow(/outside/);
    if (process.platform !== "win32") {
      const escapingLink = join(secondary, "escaping-link");
      await symlink(outside, escapingLink, "file");
      await expect(
        requireRendererProjectRootEntry("project-1", escapingLink, { projects }),
      ).rejects.toThrow(/outside/);
    }
  });
});

async function fixture(): Promise<{ root: string; project: string; sessions: string }> {
  const root = await mkdtemp(join(tmpdir(), "codeshell-project-auth-"));
  roots.push(root);
  const project = join(root, "project");
  const sessions = join(root, "sessions");
  await mkdir(project);
  await mkdir(sessions);
  return { root, project, sessions };
}

describe("requireRendererProjectPath", () => {
  test("accepts a registered project and its symlink spelling", async () => {
    const { root, project, sessions } = await fixture();
    const alias = join(root, "alias");
    const requested = process.platform === "win32" ? project : alias;
    if (process.platform !== "win32") await symlink(project, alias, "dir");
    expect(
      await requireRendererProjectPath(requested, {
        registeredPaths: [project],
        noRepoPath: join(root, "no-repo"),
        sessionRoot: sessions,
      }),
    ).toBe(await realpath(project));
  });

  test("accepts a legacy project backed by a persisted session", async () => {
    const { root, project, sessions } = await fixture();
    const sessionDir = join(sessions, "session-1");
    await mkdir(sessionDir);
    await writeFile(join(sessionDir, "state.json"), JSON.stringify({ cwd: project }));
    expect(
      await requireRendererProjectPath(project, {
        registeredPaths: [],
        noRepoPath: join(root, "no-repo"),
        sessionRoot: sessions,
      }),
    ).toBe(await realpath(project));

    await rm(join(sessionDir, "state.json"));
    expect(
      await requireRendererProjectPath(project, {
        registeredPaths: [],
        noRepoPath: join(root, "no-repo"),
        sessionRoot: sessions,
      }),
    ).toBe(await realpath(project));
  });

  test("rejects an arbitrary directory and ignores corrupt session state", async () => {
    const { root, project, sessions } = await fixture();
    const corrupt = join(sessions, "corrupt");
    await mkdir(corrupt);
    await writeFile(join(corrupt, "state.json"), "{");
    await expect(
      requireRendererProjectPath(project, {
        registeredPaths: [],
        noRepoPath: join(root, "no-repo"),
        sessionRoot: sessions,
      }),
    ).rejects.toThrow(/not registered/);
  });

  test("rejects relative, missing, and file-shaped paths", async () => {
    const { root, sessions } = await fixture();
    const file = join(root, "file");
    await writeFile(file, "x");
    const options = {
      registeredPaths: [],
      noRepoPath: join(root, "no-repo"),
      sessionRoot: sessions,
    };
    await expect(requireRendererProjectPath("relative", options)).rejects.toThrow(/absolute/);
    await expect(requireRendererProjectPath(join(root, "missing"), options)).rejects.toThrow(
      /existing/,
    );
    await expect(requireRendererProjectPath(file, options)).rejects.toThrow(/directory/);
  });

  test("accepts only the explicit empty-string sentinel for global settings scope", async () => {
    const { root, sessions } = await fixture();
    const options = {
      registeredPaths: [],
      noRepoPath: join(root, "no-repo"),
      sessionRoot: sessions,
    };

    await expect(requireRendererProjectPathOrGlobal("", options)).resolves.toBe("");
    await expect(requireRendererProjectPathOrGlobal(" ", options)).rejects.toThrow(/absolute/);
    await expect(requireRendererProjectPathOrGlobal(null, options)).rejects.toThrow(/absolute/);
  });

  test("accepts project entries but rejects paths and symlinks that escape the project", async () => {
    const { root, project } = await fixture();
    const inside = join(project, "inside.txt");
    const outside = join(root, "outside.txt");
    await writeFile(inside, "inside");
    await writeFile(outside, "outside");

    await expect(requireRendererProjectEntryPath(inside, project)).resolves.toBe(
      await realpath(inside),
    );
    await expect(requireRendererProjectEntryPath(outside, project)).rejects.toThrow(/outside/);
    if (process.platform !== "win32") {
      const escapingLink = join(project, "escaping-link");
      await symlink(outside, escapingLink, "file");
      await expect(requireRendererProjectEntryPath(escapingLink, project)).rejects.toThrow(
        /outside/,
      );
    }
  });
});
