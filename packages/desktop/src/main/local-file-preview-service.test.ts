import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdtemp,
  mkdir,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileExists, readDirectory, readFile } from "./fs-service.js";
import { readGitBlobVersion } from "./file-version-service.js";
import { localFileExists, readLocalFilePreview } from "./local-file-preview-service.js";
import { probeExternalChangedFiles } from "../../../coding/src/cc-orchestrator/external-change-provenance.js";

describe("explicit local file preview", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codeshell-local-preview-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("previews an external file without granting its directory as a workspace root", async () => {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const path = join(root, "outside.md");
    await writeFile(path, "# 外部文件\n");

    expect(await localFileExists(path)).toBe(true);
    expect(await readLocalFilePreview(path)).toEqual({
      path: await realpath(path),
      text: "# 外部文件\n",
      size: Buffer.byteLength("# 外部文件\n"),
    });
    expect(await fileExists(workspace, path)).toBe(false);
    await expect(readFile(workspace, path)).rejects.toThrow("path escapes workspace root");
    await expect(readDirectory(workspace, root)).rejects.toThrow("path escapes workspace root");
  });

  test("missing local files return a stable reason", async () => {
    await writeFile(join(root, "file"), "x");
    for (const path of [join(root, "missing.md"), join(root, "file/child")])
      expect(await readLocalFilePreview(path)).toEqual({
        path,
        text: null,
        reason: "missing",
        size: 0,
      });
  });

  test("rejects directories, missing files, relative paths, NUL and oversized path values", async () => {
    const invalid = [root, "README.md", "/tmp/\0file", "/".repeat(32_769)];
    for (const path of invalid) {
      expect(await localFileExists(path)).toBe(false);
      await expect(readLocalFilePreview(path)).rejects.toThrow();
    }
    expect(await localFileExists(null)).toBe(false);
    await expect(readLocalFilePreview(null)).rejects.toThrow();
    if (process.platform !== "win32") {
      expect(await localFileExists("/dev/null")).toBe(false);
      await expect(readLocalFilePreview("/dev/null")).rejects.toThrow("regular file");
    }
  });

  test("opens an explicitly named file symlink without widening workspace symlink authority", async () => {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const target = join(root, "target.txt");
    const path = join(workspace, "link.txt");
    await writeFile(target, "target");
    await symlink(target, path);

    expect(await localFileExists(path)).toBe(true);
    expect((await readLocalFilePreview(path)).text).toBe("target");
    expect(await fileExists(workspace, path)).toBe(false);
    expect(await readDirectory(workspace, workspace)).toEqual([]);
  });

  test("returns an image data URL only for the explicitly requested image", async () => {
    const path = join(root, "diagram.svg");
    const image = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
    await writeFile(path, image);
    const preview = await readLocalFilePreview(path);
    expect(preview.imageDataUrl).toBe(
      `data:image/svg+xml;base64,${Buffer.from(image).toString("base64")}`,
    );
    expect(preview.text).toBeNull();
    expect(preview.size).toBe(Buffer.byteLength(image));
  });

  test("keeps text/image byte limits and binary fallback", async () => {
    const text = join(root, "large.txt");
    await writeFile(text, "");
    await truncate(text, 2_000_001);
    expect(await readLocalFilePreview(text)).toMatchObject({ text: null, reason: "too-large" });

    const image = join(root, "large.png");
    await writeFile(image, "");
    await truncate(image, 25 * 1024 * 1024 + 1);
    expect(await readLocalFilePreview(image)).toMatchObject({ text: null, reason: "too-large" });
    expect((await readLocalFilePreview(image)).imageDataUrl).toBeUndefined();

    const binary = join(root, "binary.dat");
    await writeFile(binary, Buffer.from([1, 0, 2]));
    expect(await readLocalFilePreview(binary)).toMatchObject({
      text: null,
      reason: "binary",
      size: 3,
    });
  });
});

// Read-only historical versions share the same authorized-root boundary as previews.
describe("file versions", () => {
  let root: string;
  function git(cwd: string, ...args: string[]) {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  }
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "version-")));
    git(root, "init", "-q");
    git(root, "config", "user.name", "Fixture");
    git(root, "config", "user.email", "fixture@example.invalid");
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub/a.md"), "# exact history\n![image](private.png)\n");
    await writeFile(join(root, "other"), "outside authorized subdir");
    await writeFile(join(root, "binary"), Buffer.from([1, 0, 2]));
    await writeFile(join(root, "invalid-utf8"), Buffer.from([0xff, 0xfe]));
    await writeFile(join(root, "large"), Buffer.alloc(2_000_001, 97));
    await symlink("sub/a.md", join(root, "link"));
    git(root, "add", ".");
    git(root, "commit", "-qm", "fixture");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  async function ref(path = "sub/a.md", cwd = root) {
    return (await probeExternalChangedFiles(cwd, [path])).files[0]!.contentRef!;
  }

  describe("authorized Git blob versions", () => {
    test("reads exact committed bytes from the main repository after linked worktree removal", async () => {
      const wt = root + "-linked";
      git(root, "worktree", "add", "-qb", "version-fixture", wt);
      await writeFile(join(wt, "sub/a.md"), "linked completion bytes\n");
      git(wt, "add", ".");
      git(wt, "commit", "-qm", "linked commit");
      const reference = await ref("sub/a.md", wt);
      git(root, "worktree", "remove", "--force", wt);
      expect(await readGitBlobVersion(root, reference)).toMatchObject({
        status: "ok",
        text: "linked completion bytes\n",
        commit: reference.commit,
      });
      expect(
        await readGitBlobVersion(root, { ...reference, worktreePath: "/untrusted/display-only" }),
      ).toMatchObject({ status: "ok" });
    });
    test("requires commit:path == regular blob, objects, valid UTF8 and bounded content", async () => {
      const reference = await ref();
      expect(await readGitBlobVersion(root, { ...reference, blob: "a".repeat(40) })).toMatchObject({
        status: "unavailable",
        reason: "mismatch",
      });
      expect(
        await readGitBlobVersion(root, { ...reference, commit: "a".repeat(40) }),
      ).toMatchObject({
        status: "unavailable",
        reason: "object-missing",
      });
      expect(
        await readGitBlobVersion(root, {
          ...reference,
          repoPath: "link",
          blob: git(root, "rev-parse", "HEAD:link"),
        }),
      ).toMatchObject({ status: "unavailable", reason: "mismatch" });
      expect(await readGitBlobVersion(root, await ref("binary"))).toMatchObject({
        status: "unavailable",
        reason: "binary",
      });
      expect(await readGitBlobVersion(root, await ref("invalid-utf8"))).toMatchObject({
        status: "unavailable",
        reason: "invalid-utf8",
      });
      expect(await readGitBlobVersion(root, await ref("large"))).toMatchObject({
        status: "unavailable",
        reason: "too-large",
      });
      for (const invalid of [
        null,
        {},
        { ...reference, repoPath: "../secret" },
        { ...reference, commit: "--help" },
      ])
        await expect(readGitBlobVersion(root, invalid)).rejects.toThrow("Invalid");
    });
    test("uses literal special names and preserves UTF-8 BOM bytes", async () => {
      for (const path of [":(glob)*.ts", "space [文]\n.ts", "bom.txt"])
        await writeFile(join(root, path), path === "bom.txt" ? "\uFEFFprecise UTF8\n" : path);
      git(root, "--literal-pathspecs", "add", "--", ":(glob)*.ts", "space [文]\n.ts", "bom.txt");
      git(root, "commit", "-qm", "special names");
      for (const path of [":(glob)*.ts", "space [文]\n.ts", "bom.txt"])
        expect(await readGitBlobVersion(root, await ref(path))).toMatchObject({
          status: "ok",
          text: path === "bom.txt" ? "\uFEFFprecise UTF8\n" : path,
        });
    });
    test("subdirectory authorization cannot read siblings or escape via symlinks", async () => {
      expect(await readGitBlobVersion(join(root, "sub"), await ref())).toMatchObject({
        status: "ok",
      });
      await expect(readGitBlobVersion(join(root, "sub"), await ref("other"))).rejects.toThrow(
        "authorized root",
      );
      const external = await mkdtemp(join(tmpdir(), "notrepo-"));
      try {
        expect(await readGitBlobVersion(external, await ref())).toMatchObject({
          status: "unavailable",
          reason: "not-a-repository",
        });
      } finally {
        await rm(external, { recursive: true, force: true });
      }
    });
    test("rejects a repository replaced at the same path even with identical objects", async () => {
      const reference = await ref();
      await rename(join(root, ".git"), join(root, ".git-original"));
      await cp(join(root, ".git-original"), join(root, ".git"), { recursive: true });
      expect(await readGitBlobVersion(root, reference)).toMatchObject({
        status: "unavailable",
        reason: "repository-mismatch",
      });
    });
    test("binds repository identity even for cloned objects and ignores malicious Git environment", async () => {
      const reference = await ref();
      const clone = root + "-clone";
      git(root, "clone", "--quiet", "--no-hardlinks", root, clone);
      try {
        expect(await readGitBlobVersion(clone, reference)).toMatchObject({
          status: "unavailable",
          reason: "repository-mismatch",
        });
        const { repositoryId: _id, ...unbound } = reference;
        expect(await readGitBlobVersion(root, unbound)).toMatchObject({
          status: "unavailable",
          reason: "repository-mismatch",
        });
        const old = { ...process.env };
        Object.assign(process.env, {
          GIT_DIR: clone,
          GIT_WORK_TREE: clone,
          GIT_INDEX_FILE: "/no-index",
          GIT_OBJECT_DIRECTORY: "/no-objects",
          GIT_ALTERNATE_OBJECT_DIRECTORIES: clone,
          GIT_COMMON_DIR: clone,
          GIT_NAMESPACE: "evil",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "core.worktree",
          GIT_CONFIG_VALUE_0: clone,
        });
        try {
          expect(await readGitBlobVersion(root, reference)).toMatchObject({
            status: "ok",
            text: "# exact history\n![image](private.png)\n",
          });
        } finally {
          for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
          Object.assign(process.env, old);
        }
      } finally {
        await rm(clone, { recursive: true, force: true });
      }
    });
  });
});
