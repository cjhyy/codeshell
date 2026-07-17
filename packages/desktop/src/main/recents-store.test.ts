import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __setRecentsFileForTest,
  loadProjects,
  loadRecents,
  pushRecent,
  setPinned,
  softDelete,
} from "./recents-store.js";

let dir: string;
let file: string;
const externalPaths: string[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "recents-"));
  file = join(dir, "recents.json");
  __setRecentsFileForTest(file);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const externalPath of externalPaths.splice(0)) {
    rmSync(externalPath, { recursive: true, force: true });
  }
  __setRecentsFileForTest(null);
});

function makeProject(name: string): string {
  const projectPath = join(dir, name);
  mkdirSync(projectPath, { recursive: true });
  return projectPath;
}

function rawRegistry(): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
}

describe("recents-store project source", () => {
  test("softDelete hides project from loadProjects and persists across reload", async () => {
    await pushRecent({ path: dir, name: "a", lastOpenedAt: 1 });
    await softDelete(dir);
    expect((await loadProjects()).find((p) => p.path === dir)).toBeUndefined();
    // simulate restart: loadProjects re-reads the file
    expect((await loadProjects()).find((p) => p.path === dir)).toBeUndefined();
  });

  test("softDelete also hides from loadRecents (so the menu doesn't show it)", async () => {
    await pushRecent({ path: dir, name: "a", lastOpenedAt: 1 });
    await softDelete(dir);
    expect((await loadRecents()).find((p) => p.path === dir)).toBeUndefined();
  });

  test("re-pushing a soft-deleted project un-deletes it", async () => {
    await pushRecent({ path: dir, name: "a", lastOpenedAt: 1 });
    await softDelete(dir);
    await pushRecent({ path: dir, name: "a", lastOpenedAt: 2 });
    expect((await loadProjects()).find((p) => p.path === realpathSync(dir))).toBeDefined();
  });

  test("pinned project survives even when many recents are pushed", async () => {
    await pushRecent({ path: dir, name: "pinme", lastOpenedAt: 1 });
    await setPinned(dir, true);
    for (let i = 0; i < 15; i++) {
      const p = join(dir, `sub${i}`);
      mkdirSync(p, { recursive: true }); // existsSync self-heal needs the dir to exist
      await pushRecent({ path: p, name: `n${i}`, lastOpenedAt: i + 2 });
    }
    const projects = await loadProjects();
    expect(projects.find((p) => p.path === realpathSync(dir))?.pinned).toBe(true);
  });

  test("git subdirectories merge into the repository root", async () => {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    const sub = join(dir, "packages", "desktop");
    mkdirSync(sub, { recursive: true });
    await pushRecent({ path: sub, name: "desktop", lastOpenedAt: 1 });
    await pushRecent({ path: dir, name: "root", lastOpenedAt: 2 });
    await setPinned(sub, true);
    const projects = await loadProjects();
    expect(projects).toHaveLength(1);
    const root = realpathSync(dir);
    expect(projects[0]?.path).toBe(root);
    expect(projects[0]?.name).toBe("root");
    expect(projects[0]?.pinned).toBe(true);
  });

  test("serializes concurrent push, pin, and delete mutations without lost updates", async () => {
    const alpha = makeProject("alpha");
    const beta = makeProject("beta");
    const gamma = makeProject("gamma");
    const delta = makeProject("delta");

    await Promise.all([
      pushRecent({ path: alpha, name: "Alpha", lastOpenedAt: 1 }),
      pushRecent({ path: beta, name: "Beta", lastOpenedAt: 2 }),
      pushRecent({ path: gamma, name: "Gamma", lastOpenedAt: 3 }),
    ]);
    await Promise.all([
      setPinned(alpha, true),
      softDelete(beta),
      pushRecent({ path: delta, name: "Delta", lastOpenedAt: 4 }),
    ]);

    const projects = await loadProjects();
    expect(projects.map((project) => project.path)).toEqual([
      realpathSync(alpha),
      realpathSync(delta),
      realpathSync(gamma),
    ]);
    expect(projects[0]?.pinned).toBe(true);
    expect(
      typeof rawRegistry().find((project) => project.path === realpathSync(beta))?.deletedAt,
    ).toBe("number");
  });

  test("writes with an exclusive unique temp, atomic rename, cleanup, and owner-only mode", async () => {
    const projects = Array.from({ length: 8 }, (_, index) => makeProject(`atomic-${index}`));
    await Promise.all(
      projects.map((projectPath, index) =>
        pushRecent({
          path: projectPath,
          name: `Atomic ${index}`,
          lastOpenedAt: index + 1,
        }),
      ),
    );

    expect(
      readdirSync(dir).filter((name) => name.startsWith("recents.json.") || name.endsWith(".tmp")),
    ).toEqual([]);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(rawRegistry()).toHaveLength(projects.length);
  });

  test("isolates invalid entries while preserving every valid project shape", async () => {
    const valid = makeProject("valid");
    writeFileSync(
      file,
      JSON.stringify([
        { path: valid, name: "Valid", lastOpenedAt: 5, pinned: true, extra: "discarded" },
        null,
        "not-an-object",
        { path: "", name: "Empty path", lastOpenedAt: 4 },
        { path: "relative", name: "Relative", lastOpenedAt: 4 },
        { path: makeProject("empty-name"), name: " ", lastOpenedAt: 4 },
        { path: makeProject("bad-name"), name: "bad\nname", lastOpenedAt: 4 },
        { path: makeProject("bad-time"), name: "Bad time", lastOpenedAt: Number.NaN },
        { path: makeProject("bad-pin"), name: "Bad pin", lastOpenedAt: 3, pinned: "yes" },
      ]),
    );

    expect(await loadProjects()).toEqual([
      {
        path: realpathSync(valid),
        name: "Valid",
        lastOpenedAt: 5,
        pinned: true,
      },
    ]);

    await setPinned(valid, false);
    expect(rawRegistry()).toEqual([
      {
        path: realpathSync(valid),
        name: "Valid",
        lastOpenedAt: 5,
        pinned: false,
      },
    ]);
  });

  test("bounds the complete registry generously while retaining pinned entries", async () => {
    const pinned = makeProject("pinned-at-boundary");
    const raw = [
      ...Array.from({ length: 5_000 }, (_, index) => ({
        path: join(dir, `missing-${index}`),
        name: `Missing ${index}`,
        lastOpenedAt: 10_000 - index,
      })),
      {
        path: pinned,
        name: "Pinned",
        lastOpenedAt: 1,
        pinned: true,
      },
    ];
    writeFileSync(file, JSON.stringify(raw));

    expect(await loadProjects()).toEqual([
      {
        path: realpathSync(pinned),
        name: "Pinned",
        lastOpenedAt: 1,
        pinned: true,
      },
    ]);
    await setPinned(pinned, false);
    expect(rawRegistry()).toHaveLength(5_000);
    expect(rawRegistry().some((project) => project.path === realpathSync(pinned))).toBe(true);
  });

  test("does not overwrite malformed top-level data with an empty registry", async () => {
    const malformed = JSON.stringify({
      path: dir,
      name: "Good data in the wrong envelope",
      lastOpenedAt: 1,
    });
    writeFileSync(file, malformed);
    const project = makeProject("new-project");

    expect(await loadProjects()).toEqual([]);
    await expect(pushRecent({ path: project, name: "New", lastOpenedAt: 2 })).rejects.toThrow(
      /top-level value must be an array/,
    );
    expect(readFileSync(file, "utf8")).toBe(malformed);

    // A rejected mutation must not poison the in-process serialization queue.
    writeFileSync(file, "[]");
    await pushRecent({ path: project, name: "New", lastOpenedAt: 2 });
    expect(await loadProjects()).toHaveLength(1);
  });

  test("does not overwrite unparseable JSON during a mutation", async () => {
    writeFileSync(file, "[not json");
    const project = makeProject("new-project");

    expect(await loadRecents()).toEqual([]);
    await expect(pushRecent({ path: project, name: "New", lastOpenedAt: 2 })).rejects.toThrow(
      /JSON parse failed/,
    );
    expect(readFileSync(file, "utf8")).toBe("[not json");
  });

  test("never follows a symlinked registry file", async () => {
    if (process.platform === "win32") return;
    const externalDir = mkdtempSync(join(tmpdir(), "recents-target-"));
    externalPaths.push(externalDir);
    const externalFile = join(externalDir, "registry.json");
    const externalRaw = JSON.stringify([{ path: dir, name: "External project", lastOpenedAt: 1 }]);
    writeFileSync(externalFile, externalRaw);
    symlinkSync(externalFile, file);
    const project = makeProject("new-project");

    expect(await loadProjects()).toEqual([]);
    await expect(pushRecent({ path: project, name: "New", lastOpenedAt: 2 })).rejects.toThrow(
      /symbolic link/,
    );
    expect(readFileSync(externalFile, "utf8")).toBe(externalRaw);
  });
});
