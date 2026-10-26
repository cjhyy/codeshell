import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  requireRendererLinkedSessionPath,
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
          {
            id: "primary",
            path: project,
            canonicalIdentity: await realpath(project),
            name: "project",
            addedAt: 1,
          },
          {
            id: "secondary",
            path: secondary,
            canonicalIdentity: await realpath(secondary),
            name: "secondary",
            addedAt: 2,
          },
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
    await expect(requireRendererProjectRoot("project-1", "unknown", { projects })).rejects.toThrow(
      /root not found/,
    );
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
          {
            id: "primary",
            path: project,
            canonicalIdentity: await realpath(project),
            name: "project",
            addedAt: 1,
          },
          {
            id: "secondary",
            path: secondary,
            canonicalIdentity: await realpath(secondary),
            name: "secondary",
            addedAt: 2,
          },
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

  test("rejects an fsRoot whose registered directory was replaced by an outside symlink", async () => {
    if (process.platform === "win32") return;
    const { root, project } = await fixture();
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "outside");
    const projects = [
      {
        id: "project-1",
        name: "Project",
        roots: [
          {
            id: "primary",
            path: project,
            canonicalIdentity: await realpath(project),
            name: "project",
            addedAt: 1,
          },
        ],
        primaryRootId: "primary",
        createdAt: 1,
        updatedAt: 1,
        lastOpenedAt: 1,
        revision: 1,
      },
    ];

    await rm(project, { recursive: true, force: true });
    await symlink(outside, project, "dir");
    await expect(requireRendererProjectRoot("project-1", "primary", { projects })).rejects.toThrow(
      /root_replaced/,
    );
    await expect(
      requireRendererProjectRootEntry("project-1", join(project, "secret.txt"), { projects }),
    ).rejects.toThrow(/root_replaced|outside/);
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
    const { root, project } = await fixture();
    const alias = join(root, "alias");
    const requested = process.platform === "win32" ? project : alias;
    if (process.platform !== "win32") await symlink(project, alias, "dir");
    expect(
      await requireRendererProjectPath(requested, {
        registeredPaths: [project],
        noRepoPath: join(root, "no-repo"),
      }),
    ).toBe(await realpath(project));
  });

  test("does not treat a persisted Session cwd as general project authorization", async () => {
    const { root, project, sessions } = await fixture();
    const sessionDir = join(sessions, "session-1");
    await mkdir(sessionDir);
    await writeFile(join(sessionDir, "state.json"), JSON.stringify({ cwd: project }));
    await expect(
      requireRendererProjectPath(project, {
        registeredPaths: [],
        noRepoPath: join(root, "no-repo"),
      }),
    ).rejects.toThrow(/not registered/);
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
      }),
    ).rejects.toThrow(/not registered/);
  });

  test("rejects relative, missing, and file-shaped paths", async () => {
    const { root } = await fixture();
    const file = join(root, "file");
    await writeFile(file, "x");
    const options = {
      registeredPaths: [],
      noRepoPath: join(root, "no-repo"),
    };
    await expect(requireRendererProjectPath("relative", options)).rejects.toThrow(/absolute/);
    await expect(requireRendererProjectPath(join(root, "missing"), options)).rejects.toThrow(
      /existing/,
    );
    await expect(requireRendererProjectPath(file, options)).rejects.toThrow(/directory/);
  });

  test("accepts only the explicit empty-string sentinel for global settings scope", async () => {
    const { root } = await fixture();
    const options = {
      registeredPaths: [],
      noRepoPath: join(root, "no-repo"),
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

/** Lay out a linked worktree exactly as `git worktree add` records it. */
async function linkWorktree(repository: string, worktree: string, name: string): Promise<void> {
  const adminDir = join(repository, ".git", "worktrees", name);
  await mkdir(adminDir, { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeFile(join(adminDir, "commondir"), "../..\n");
  await writeFile(join(adminDir, "gitdir"), `${join(worktree, ".git")}\n`);
  await writeFile(join(worktree, ".git"), `gitdir: ${adminDir}\n`);
}

describe("requireRendererLinkedSessionPath", () => {
  test("accepts registered roots, directories inside them, and their in-tree worktrees", async () => {
    const { root, project } = await fixture();
    await mkdir(join(project, ".git"));
    const nested = join(project, "packages", "app");
    await mkdir(nested, { recursive: true });
    const inTree = join(project, ".worktrees", "feature");
    await linkWorktree(project, inTree, "feature");
    const options = { registeredPaths: [project], noRepoPath: join(root, "no-repo") };

    for (const path of [project, nested, inTree]) {
      await expect(requireRendererLinkedSessionPath(path, options)).resolves.toBe(
        await realpath(path),
      );
    }
  });

  test("accepts a worktree outside the root only when the repository lists it back", async () => {
    const { root, project } = await fixture();
    await mkdir(join(project, ".git"));
    const worktree = join(root, "codex-worktrees", "job");
    await linkWorktree(project, worktree, "job");
    const nested = join(worktree, "src");
    await mkdir(nested);
    const options = { registeredPaths: [project], noRepoPath: join(root, "no-repo") };

    await expect(requireRendererLinkedSessionPath(worktree, options)).resolves.toBe(
      await realpath(worktree),
    );
    await expect(requireRendererLinkedSessionPath(nested, options)).resolves.toBe(
      await realpath(nested),
    );
    // Strict project-root authorization is unchanged for every other IPC.
    await expect(requireRendererProjectPath(worktree, options)).rejects.toThrow(/not registered/);

    // A forged .git file naming the repository's admin dir is not listed back.
    const forged = join(root, "forged");
    await mkdir(forged);
    await writeFile(join(forged, ".git"), `gitdir: ${join(project, ".git", "worktrees", "job")}\n`);
    await expect(requireRendererLinkedSessionPath(forged, options)).rejects.toThrow(
      /not registered/,
    );
  });

  test("rejects worktrees of unregistered repositories and unrelated directories", async () => {
    const { root, project } = await fixture();
    const other = join(root, "other-repo");
    await mkdir(join(other, ".git"), { recursive: true });
    const worktree = join(root, "other-worktree");
    await linkWorktree(other, worktree, "wt");
    const options = { registeredPaths: [project], noRepoPath: join(root, "no-repo") };

    await expect(requireRendererLinkedSessionPath(worktree, options)).rejects.toThrow(
      /not registered/,
    );
    await expect(requireRendererLinkedSessionPath(root, options)).rejects.toThrow(/not registered/);
    await expect(requireRendererLinkedSessionPath("relative", options)).rejects.toThrow(/absolute/);
  });
});
