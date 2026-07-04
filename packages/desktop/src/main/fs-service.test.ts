import { describe, it, expect } from "bun:test";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileExists } from "./fs-service.js";

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
});
