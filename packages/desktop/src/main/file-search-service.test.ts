import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRendererProjectFileSearch,
  searchFiles,
  searchProjectFiles,
} from "./file-search-service.js";
import { requireRendererProject, requireRendererProjectRoot } from "./renderer-project-path.js";
import type { LocalProject } from "./project-store.js";
import { createProjectAuthorityApi } from "../preload/project-authority-api.js";

const owned: string[] = [];
afterEach(async () => {
  await Promise.all(owned.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function ownedDirectory() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "file-search-git-")));
  owned.push(path);
  return path;
}

function initGit(path: string) {
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", path], { stdio: "pipe" });
  execFileSync("git", ["-C", path, "config", "core.quotePath", "true"], { stdio: "pipe" });
}

describe("real Git filenames", () => {
  test("returns readable tracked and untracked Unicode paths without Git quoting", async () => {
    const cwd = await ownedDirectory();
    initGit(cwd);
    await mkdir(join(cwd, "中文 目录"));
    const names = ["报告.md", "ascii.md", "中文 目录/草稿😀.md", " leading.md"];
    for (const name of names) await writeFile(join(cwd, name), name);
    await writeFile(join(cwd, ".gitignore"), "ignored.md\n");
    await writeFile(join(cwd, "ignored.md"), "ignored fixture");
    execFileSync("git", ["-C", cwd, "add", "--", "报告.md"], { stdio: "pipe" });
    const hits = await searchFiles(cwd, "");
    expect(
      hits
        .filter((hit) => hit.kind === "file")
        .map((hit) => hit.path)
        .sort(),
    ).toEqual([...names, ".gitignore"].sort());
    for (const hit of hits) await access(join(cwd, hit.path));
    expect((await searchFiles(cwd, "报告")).map((hit) => hit.path)).toEqual(["报告.md"]);
    expect((await searchFiles(cwd, "草稿")).map((hit) => hit.path)).toEqual([
      "中文 目录/草稿😀.md",
    ]);
    expect(await searchFiles(cwd, "ignored")).toEqual([]);
  });

  test.skipIf(process.platform === "win32")(
    "preserves embedded delimiters, quotes, backslashes and surrounding filename whitespace",
    async () => {
      const cwd = await ownedDirectory();
      initGit(cwd);
      const names = [
        "line\nbreak.md",
        "tab\tname.md",
        'quoted"name.md',
        "back\\slash.md",
        " padded.md ",
      ];
      for (const name of names) await writeFile(join(cwd, name), name);
      execFileSync("git", ["-C", cwd, "add", "--", names[0]!], { stdio: "pipe" });
      const hits = await searchFiles(cwd, "");
      expect(hits.map((hit) => hit.path).sort()).toEqual([...names].sort());
      for (const hit of hits) {
        expect(hit.name).toBe(hit.path);
        expect(await readFile(join(cwd, hit.path), "utf8")).toBe(hit.path);
      }
    },
  );
});

async function projectSearchFixture() {
  const directory = await ownedDirectory();
  const active = join(directory, "active");
  const other = join(directory, "other");
  for (const root of [active, other]) {
    await mkdir(root);
    initGit(root);
  }
  await mkdir(join(active, "a-long-directory"));
  await writeFile(join(active, "a-long-directory", "needle-document.md"), "active-root fixture");
  await writeFile(join(active, "报告.md"), "owned report");
  await Promise.all(
    Array.from({ length: 30 }, (_, index) =>
      writeFile(join(other, `needle-${String(index).padStart(2, "0")}.md`), "other-root fixture"),
    ),
  );
  const project: LocalProject = {
    id: "project-1",
    name: "Owned multi-root project",
    roots: [
      { id: "active", name: "Active", path: active, canonicalIdentity: active, addedAt: 1 },
      { id: "other", name: "Other", path: other, canonicalIdentity: other, addedAt: 1 },
    ],
    primaryRootId: "other",
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
    revision: 1,
  };
  const projects = [project];
  const handler = createRendererProjectFileSearch({
    requireProject: (projectId) => requireRendererProject(projectId, { projects }),
    requireRoot: (projectId, rootId) => requireRendererProjectRoot(projectId, rootId, { projects }),
  });
  const calls: unknown[][] = [];
  const api = createProjectAuthorityApi({
    invoke: async (channel, ...args) => {
      expect(channel).toBe("files:searchProject");
      calls.push(args);
      return handler(args[0], args[1], args[2]);
    },
  } as Parameters<typeof createProjectAuthorityApi>[0]);
  return { active, other, directory, project, handler, api, calls };
}

describe("root-scoped preload and authorized Main search", () => {
  test("filters the selected registered root before the top30 cap while preserving global callers", async () => {
    const { api, calls, active } = await projectSearchFixture();
    const global = await api.searchProjectFiles("project-1", "needle");
    expect(global).toHaveLength(30);
    expect(global.every((hit) => hit.rootId === "other")).toBe(true);
    const selected = await api.searchProjectFiles("project-1", "needle", "active");
    expect(selected).toEqual([
      {
        rootId: "active",
        path: "a-long-directory/needle-document.md",
        name: "needle-document.md",
        kind: "file",
      },
    ]);
    expect(await readFile(join(active, selected[0]!.path), "utf8")).toBe("active-root fixture");
    expect(
      (await api.searchProjectFiles("project-1", "报告", "active")).map((hit) => hit.path),
    ).toEqual(["报告.md"]);
    expect(calls).toEqual([
      ["project-1", "needle"],
      ["project-1", "needle", "active"],
      ["project-1", "报告", "active"],
    ]);
  });

  test("unknown, null and removed roots cannot fall back to another mounted root", async () => {
    const { api, project, handler } = await projectSearchFixture();
    await expect(api.searchProjectFiles("project-1", "needle", "foreign-root")).rejects.toThrow(
      "root not found",
    );
    await expect(handler("project-1", "needle", null)).rejects.toThrow("root id is required");
    await expect(api.searchProjectFiles("foreign-project", "needle", "active")).rejects.toThrow(
      "project not found",
    );
    await expect(api.searchProjectFiles("project-1", "x".repeat(513), "active")).rejects.toThrow(
      "query is too long",
    );
    project.roots = project.roots.filter((root) => root.id !== "active");
    await expect(api.searchProjectFiles("project-1", "needle", "active")).rejects.toThrow(
      "root not found",
    );
  });

  test.skipIf(process.platform === "win32")(
    "a replaced root is rejected before using its cached file list",
    async () => {
      const { api, active, other, directory } = await projectSearchFixture();
      expect((await api.searchProjectFiles("project-1", "报告", "active"))[0]?.path).toBe(
        "报告.md",
      );
      await rename(active, join(directory, "active-original"));
      await symlink(other, active);
      await expect(api.searchProjectFiles("project-1", "needle", "active")).rejects.toThrow(
        "root_replaced",
      );
    },
  );
});

describe("searchFiles", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "file-search-"));
    mkdirSync(join(cwd, "src", "components"), { recursive: true });
    mkdirSync(join(cwd, "docs"), { recursive: true });
    mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(cwd, "src", "components", "Button.tsx"), "export {}\n");
    writeFileSync(join(cwd, "docs", "guide.md"), "# guide\n");
    writeFileSync(join(cwd, "node_modules", "pkg", "index.js"), "module.exports = {}\n");
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("returns file and directory hits with kind", async () => {
    const hits = await searchFiles(cwd, "src");
    expect(hits.some((hit) => hit.path === "src" && hit.kind === "dir")).toBe(true);
    expect(hits.some((hit) => hit.path === "src/components" && hit.kind === "dir")).toBe(true);
    expect(
      hits.some((hit) => hit.path === "src/components/Button.tsx" && hit.kind === "file"),
    ).toBe(true);
  });

  test("ignored directories do not appear", async () => {
    const hits = await searchFiles(cwd, "node");
    expect(hits.some((hit) => hit.path.startsWith("node_modules"))).toBe(false);
  });
});

describe("searchProjectFiles", () => {
  test("merges roots serially, preserves rootId, deduplicates, reranks, and caps results", async () => {
    const calls: string[] = [];
    const hits = await searchProjectFiles(
      [
        { id: "root-a", path: "/a" },
        { id: "root-b", path: "/b" },
      ],
      "button",
      async (cwd) => {
        calls.push(cwd);
        if (cwd === "/a") {
          return [
            { path: "src/Button.tsx", name: "Button.tsx", kind: "file" },
            { path: "src/Button.tsx", name: "Button.tsx", kind: "file" },
          ];
        }
        return Array.from({ length: 35 }, (_, index) => ({
          path: index === 0 ? "Button.md" : `docs/button-${index}.md`,
          name: index === 0 ? "Button.md" : `button-${index}.md`,
          kind: "file" as const,
        }));
      },
    );

    expect(calls).toEqual(["/a", "/b"]);
    expect(hits).toHaveLength(30);
    expect(hits[0]).toMatchObject({ rootId: "root-b", path: "Button.md" });
    expect(
      hits.filter((hit) => hit.rootId === "root-a" && hit.path === "src/Button.tsx"),
    ).toHaveLength(1);
    expect(hits.some((hit) => hit.rootId === "root-b")).toBe(true);
  });
});
