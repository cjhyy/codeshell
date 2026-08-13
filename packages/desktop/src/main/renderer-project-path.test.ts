import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  requireRendererProjectEntryPath,
  requireRendererProjectPath,
} from "./renderer-project-path.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
      await expect(requireRendererProjectEntryPath(escapingLink, project)).rejects.toThrow(/outside/);
    }
  });
});
