import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { resolveMobileStaticRoot } from "./mobile-static-root";

const manifest = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../../../package.json"), "utf8"),
) as { build: { files: string[]; asarUnpack: string[] } };

describe("resolveMobileStaticRoot", () => {
  test("keeps the unpackaged build sibling of out/main", () => {
    const main = join(sep, "repo", "packages", "desktop", "out", "main");
    expect(resolveMobileStaticRoot(main)).toBe(
      join(sep, "repo", "packages", "desktop", "out", "mobile"),
    );
  });

  test("serves a packaged build from the real unpacked directory, never the archive", () => {
    // Electron's ASAR stat reports a synthetic identity (a fresh inode on every
    // call and number fields), so the pinned-file revalidation in
    // streamStaticFile can never match a file inside app.asar.
    const resources = join(sep, "Applications", "code-shell.app", "Contents", "Resources");
    const main = join(resources, "app.asar", "out", "main");
    const root = resolveMobileStaticRoot(main);
    expect(root).toBe(join(resources, "app.asar.unpacked", "out", "mobile"));
    expect(root.split(sep)).not.toContain("app.asar");
  });

  test("maps only a whole archive segment, not a directory merely containing .asar", () => {
    const main = join(sep, "work", "my.asar.d", "app.asarx", "out", "main");
    expect(resolveMobileStaticRoot(main)).toBe(
      join(sep, "work", "my.asar.d", "app.asarx", "out", "mobile"),
    );
  });

  test("packaging ships the mobile web app outside the ASAR archive", () => {
    expect(manifest.build.files).toContain("out/**/*");
    expect(manifest.build.asarUnpack).toContain("out/mobile/**/*");
  });
});
