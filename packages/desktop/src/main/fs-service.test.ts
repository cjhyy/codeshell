import { describe, it, expect, spyOn } from "bun:test";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileExists, readFile } from "./fs-service.js";

/**
 * fileExists gates whether a path mentioned in an answer becomes a clickable
 * file link. The key regression: a RELATIVE path (the common form in answers,
 * e.g. `README.md`) must resolve against root — an earlier version passed it
 * straight to resolveWithin, which rejects anything not already under root, so
 * every relative link silently became unclickable.
 */
describe("fileExists", () => {
  it("resolves relative + absolute paths and rejects misses/escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "fsx-"));
    try {
      await writeFile(join(root, "README.md"), "# hi");
      await mkdir(join(root, "pkg", "src"), { recursive: true });
      await writeFile(join(root, "pkg", "src", "index.ts"), "x");

      // Relative paths (the bug we fixed) — join onto root.
      expect(await fileExists(root, "README.md")).toBe(true);
      expect(await fileExists(root, "pkg/src/index.ts")).toBe(true);
      expect(await fileExists(root, "./README.md")).toBe(true);

      // Absolute path under root.
      expect(await fileExists(root, join(root, "README.md"))).toBe(true);

      // Missing file → false (so an invented path isn't clickable).
      expect(await fileExists(root, "does-not-exist.ts")).toBe(false);
      expect(await fileExists(root, "pkg/nope.ts")).toBe(false);

      // A directory is not a file.
      expect(await fileExists(root, "pkg")).toBe(false);

      // Escapes the workspace root → false, never throws.
      expect(await fileExists(root, "../../../etc/passwd")).toBe(false);
      expect(await fileExists(root, "/etc/passwd")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats Windows drive-letter paths as absolute instead of joining them onto root", async () => {
    const root = await mkdtemp(join(tmpdir(), "fsx-"));
    try {
      const file = join(root, "win-path.txt");
      await writeFile(file, "x");

      expect(await fileExists(root, file)).toBe(true);
      expect(await fileExists(root, `${root}${file}`)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlink that escapes root", async () => {
    const root = await mkdtemp(join(tmpdir(), "fsx-"));
    const outside = await mkdtemp(join(tmpdir(), "fsx-out-"));
    try {
      await writeFile(join(outside, "secret.txt"), "s");
      try {
        await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") return;
        throw err;
      }
      // The symlink target's realpath leaves root → rejected.
      expect(await fileExists(root, "link.txt")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("keeps an internal file symlink readable under the existing final path policy", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "fsx-internal-link-"));
    try {
      await writeFile(join(root, "target.txt"), "inside");
      await symlink(join(root, "target.txt"), join(root, "link.txt"));
      expect(await fileExists(root, "link.txt")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("missing file content", () => {
  it("returns missing for ENOENT/ENOTDIR after authorization, and still rejects escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "fsm-"));
    const outside = await mkdtemp(join(tmpdir(), "fsm-out-"));
    try {
      const { readFile } = await import("./fs-service.js");
      await writeFile(join(root, "file"), "x");
      for (const path of [join(root, "gone.ts"), join(root, "file/child")]) {
        expect(await readFile(root, path)).toEqual({
          path,
          text: null,
          reason: "missing",
          size: 0,
        });
      }
      await expect(readFile(root, join(outside, "gone"))).rejects.toThrow("escapes");
      if (process.platform !== "win32") {
        await symlink(outside, join(root, "escape"));
        await expect(readFile(root, join(root, "escape/gone"))).rejects.toThrow("escapes");
        await symlink(join(outside, "not-created"), join(root, "dangling"));
        await expect(readFile(root, join(root, "dangling"))).rejects.toThrow("escapes");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("descriptor-bound workspace reads", () => {
  it("rejects a symlink replacement after the initial file inspection", async () => {
    if (process.platform === "win32") return;
    const root = await fs.realpath(await mkdtemp(join(tmpdir(), "fs-race-")));
    const outside = await mkdtemp(join(tmpdir(), "fs-race-out-"));
    const file = join(root, "file.txt");
    const target = join(outside, "fixture.txt");
    await writeFile(file, "inside");
    await writeFile(target, "outside fixture");
    const original = fs.open;
    const open = spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] === file) {
        await fs.unlink(file);
        await symlink(target, file);
      }
      return original(...args);
    });
    try {
      await expect(readFile(root, file)).rejects.toThrow();
    } finally {
      open.mockRestore();
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects four FIFOs without consuming the filesystem thread pool", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "fs-fifo-"));
    try {
      const fifo = join(root, "pipe");
      execFileSync("mkfifo", [fifo]);
      const reads = await Promise.allSettled(Array.from({ length: 4 }, () => readFile(root, fifo)));
      expect(reads.every((result) => result.status === "rejected")).toBe(true);
      await writeFile(join(root, "normal"), "still responsive");
      expect((await readFile(root, join(root, "normal"))).text).toBe("still responsive");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still reads internal symlinks, binary and bounded regular files", async () => {
    const root = await mkdtemp(join(tmpdir(), "fs-content-"));
    try {
      const file = join(root, "normal");
      await writeFile(file, "hello");
      if (process.platform !== "win32") {
        await symlink(file, join(root, "link"));
        expect((await readFile(root, join(root, "link"))).text).toBe("hello");
      }
      await writeFile(file, Buffer.from([0, 1]));
      expect((await readFile(root, file)).reason).toBe("binary");
      await writeFile(file, Buffer.alloc(2_000_001, 32));
      expect((await readFile(root, file)).reason).toBe("too-large");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
