import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { installLocalPlugin, installPluginFromArchive } from "./installFromArchive.js";
import { safeJoin } from "./unzip.js";
import { PluginInstallError } from "./types.js";

const STAMP = "2026-06-20T10:00:00Z";

/** Build a .zip from a directory using the system `zip` (cwd-relative entries). */
function zipDir(srcDir: string, zipPath: string): void {
  execFileSync("zip", ["-r", "-q", zipPath, "."], { cwd: srcDir });
}

describe("installLocalPlugin (dir)", () => {
  let home: string, src: string, prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-home-"));
    src = mkdtempSync(join(tmpdir(), "cs-src-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  test("installs a CC plugin dir; derives name from manifest", async () => {
    mkdirSync(join(src, ".claude-plugin"), { recursive: true });
    writeFileSync(join(src, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "My Plugin" }));
    mkdirSync(join(src, "skills", "s"), { recursive: true });
    writeFileSync(join(src, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nb");

    const { dir, name } = await installLocalPlugin({ kind: "dir", path: src }, STAMP);
    expect(name).toBe("my-plugin"); // "My Plugin" → safe single segment
    expect(existsSync(join(dir, "skills", "s", "SKILL.md"))).toBe(true);
  });

  test("dives one level when the plugin sits in a single subdir", async () => {
    const inner = join(src, "the-plugin");
    mkdirSync(join(inner, "skills"), { recursive: true });
    writeFileSync(join(inner, "skills", ".keep"), "");

    const { name } = await installLocalPlugin({ kind: "dir", path: src }, STAMP, "explicit-name");
    expect(name).toBe("explicit-name");
  });

  test("rejects a dir with no recognizable plugin", async () => {
    writeFileSync(join(src, "random.txt"), "hi");
    await expect(installLocalPlugin({ kind: "dir", path: src }, STAMP)).rejects.toThrow(/no plugin found/);
  });

  test("installLocalPlugin overwrite reinstalls an already-installed plugin", async () => {
    const writeSource = (version: string, marker: string) => {
      mkdirSync(join(src, ".claude-plugin"), { recursive: true });
      writeFileSync(
        join(src, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "upgrade-me", version }),
      );
      mkdirSync(join(src, "skills", "s"), { recursive: true });
      writeFileSync(join(src, "skills", "s", "SKILL.md"), `---\nname: s\ndescription: d\n---\n${marker}`);
    };

    // Install v1.
    writeSource("0.1.0", "v1-body");
    const first = await installLocalPlugin({ kind: "dir", path: src }, STAMP);
    expect(first.name).toBe("upgrade-me");

    // Bump the source to v2 with new content.
    writeSource("0.2.0", "v2-body");

    // Without overwrite → hard error (already installed).
    await expect(
      installLocalPlugin({ kind: "dir", path: src }, STAMP),
    ).rejects.toThrow(/already installed/);

    // With overwrite → succeeds and replaces with the new version + content.
    const second = await installLocalPlugin({ kind: "dir", path: src }, STAMP, undefined, {
      overwrite: true,
    });
    expect(second.name).toBe("upgrade-me");

    const meta = JSON.parse(readFileSync(join(second.dir, ".cs-meta.json"), "utf-8")) as {
      version?: string;
    };
    expect(meta.version).toBe("0.2.0");
    expect(readFileSync(join(second.dir, "skills", "s", "SKILL.md"), "utf-8")).toContain("v2-body");
  });
});

describe("installPluginFromArchive (zip)", () => {
  let home: string, work: string, prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-home-"));
    work = mkdtempSync(join(tmpdir(), "cs-zip-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  test("extracts and installs a zipped CC plugin", async () => {
    const content = join(work, "content");
    mkdirSync(join(content, ".claude-plugin"), { recursive: true });
    writeFileSync(join(content, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "zipplug" }));
    mkdirSync(join(content, "skills", "s"), { recursive: true });
    writeFileSync(join(content, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nb");
    const zipPath = join(work, "plug.zip");
    zipDir(content, zipPath);

    const { dir, name } = await installPluginFromArchive(zipPath, STAMP);
    expect(name).toBe("zipplug");
    expect(existsSync(join(dir, "skills", "s", "SKILL.md"))).toBe(true);
  });

  test("rejects a non-existent archive", async () => {
    await expect(installPluginFromArchive(join(work, "nope.zip"), STAMP)).rejects.toThrow(/not a file/);
  });
});

describe("safeJoin (zip-slip guard)", () => {
  const dest = "/tmp/dest";
  test("allows normal entries", () => {
    expect(safeJoin(dest, "skills/s/SKILL.md")).toBe("/tmp/dest/skills/s/SKILL.md");
  });
  test("rejects parent-traversal entries", () => {
    expect(() => safeJoin(dest, "../evil.sh")).toThrow(PluginInstallError);
    expect(() => safeJoin(dest, "a/../../evil")).toThrow(PluginInstallError);
  });
  test("rejects absolute-ish escape", () => {
    expect(() => safeJoin(dest, "../../etc/passwd")).toThrow(PluginInstallError);
  });
});
