import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, utimesSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager, sessionsRoot } from "@cjhyy/code-shell-core";
import {
  readSessionFile,
  readSessionFileSync,
  scanSessionDirectories,
  scanSessionDirectoriesSync,
} from "@cjhyy/code-shell-host";
import { listDiskSessions } from "../sessions-service.js";
import { createHubSessions, readHubSessionState } from "./session-management.js";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const run of cleanup.splice(0).reverse()) run();
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "shared-session-files-"));
  const old = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = join(dir, "home");
  cleanup.push(() => {
    if (old === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = old;
    rmSync(dir, { recursive: true, force: true });
  });
  const cwd = join(dir, "workspace");
  mkdirSync(cwd);
  const root = sessionsRoot();
  const manager = new SessionManager();
  const hub = createHubSessions({
    cwd,
    sessionRootDir: root,
    dataDir: join(dir, "hub"),
    isAuthorized: async () => true,
    isRunning: () => false,
    onChanged: () => {},
  });
  const create = (id: string, workspace = cwd, parent: string | null = null) =>
    manager.create(workspace, "fixture", "fixture", id, parent, "desktop");
  return { dir, root, cwd, manager, hub, create };
}

test("production catalogs retain their distinct ordering and stable tied cursors after deletion", async () => {
  const f = fixture();
  for (const id of ["a", "B", "c"]) f.create(id);
  // Desktop uses directory mtime; Hub uses transcript/state mtime.
  const activity = new Date(1_700_000_000_000),
    directory = new Date(1_600_000_000_000);
  for (const id of ["a", "B", "c"]) {
    utimesSync(join(f.root, id, "transcript.jsonl"), activity, activity);
    utimesSync(join(f.root, id), directory, directory);
  }
  const diskFirst = await listDiskSessions({ limit: 1 });
  const hubFirst = await f.hub.list(new URLSearchParams({ limit: "1" }));
  expect(diskFirst.sessions.map((entry) => entry.id)).toEqual(["a"]);
  expect(hubFirst.sessions.map((entry) => entry.sessionId)).toEqual(["a"]);
  rmSync(join(f.root, "a"), { recursive: true });
  expect(
    (await listDiskSessions({ limit: 2, cursor: diskFirst.nextCursor! })).sessions.map(
      (entry) => entry.id,
    ),
  ).toEqual(["B", "c"]);
  expect(
    (
      await f.hub.list(new URLSearchParams({ limit: "2", cursor: hubFirst.nextCursor! }))
    ).sessions.map((entry) => entry.sessionId),
  ).toEqual(["B", "c"]);
  utimesSync(join(f.root, "c"), new Date(1_800_000_000_000), new Date(1_800_000_000_000));
  expect((await listDiskSessions({ limit: 2 })).sessions[0]?.id).toBe("c");
  expect((await f.hub.list()).sessions[0]?.sessionId).toBe("B");
});

test("both adapters reject unsafe files and keep their own workspace/archive/child filters", async () => {
  const f = fixture();
  f.create("good");
  f.create("foreign", join(f.dir, "foreign-workspace"));
  f.create("archived");
  f.manager.setSessionArchived("archived", Date.now());
  f.create("child", join(f.dir, "missing-child-worktree"), "good");
  for (const id of ["broken", "large", "linked-file"]) f.create(id);
  writeFileSync(join(f.root, "broken", "state.json"), "{");
  writeFileSync(join(f.root, "large", "state.json"), " ".repeat(2 * 1024 * 1024 + 1));
  rmSync(join(f.root, "linked-file", "state.json"));
  symlinkSync(join(f.root, "good", "state.json"), join(f.root, "linked-file", "state.json"));
  symlinkSync(join(f.root, "good"), join(f.root, "linked-directory"));
  expect((await scanSessionDirectories()).map((entry) => entry.id)).not.toContain(
    "linked-directory",
  );
  expect(scanSessionDirectoriesSync().map((entry) => entry.id)).not.toContain("linked-directory");
  expect((await listDiskSessions({ limit: 50 })).sessions.map((entry) => entry.id)).toEqual([
    "good",
  ]);
  expect((await f.hub.list()).sessions.map((entry) => entry.sessionId)).toEqual(["good"]);
  expect(
    (await listDiskSessions({ limit: 50, parentSessionId: "good" })).sessions.map(
      (entry) => entry.id,
    ),
  ).toEqual(["child"]);
  expect(
    (await f.hub.list(new URLSearchParams({ archived: "true" }))).sessions.map(
      (entry) => entry.sessionId,
    ),
  ).toEqual(["archived"]);
  await expect(readSessionFile(f.root, "linked-file", "state.json", 1024 * 1024)).rejects.toThrow();
  expect(() => readHubSessionState(f.root, "linked-file")).toThrow();
  expect(() => readSessionFileSync(f.root, "good", "../state.json", 100)).toThrow();
  expect(() => readSessionFileSync(f.root, "../good", "state.json", 100)).toThrow();
  expect(() => readSessionFileSync(f.root, "large", "state.json", 1024)).toThrow();
  expect(() => scanSessionDirectoriesSync("relative")).toThrow();
});

test("legacy relative roots and a relative CODE_SHELL_HOME resolve once at each adapter", async () => {
  const f = fixture();
  process.env.CODE_SHELL_HOME = relative(process.cwd(), join(f.dir, "home"));
  const manager = new SessionManager();
  manager.create(f.cwd, "fixture", "fixture", "relative-root", null, "desktop");
  const root = relative(process.cwd(), f.root);
  expect((await listDiskSessions({ limit: 10 })).sessions.map((entry) => entry.id)).toEqual([
    "relative-root",
  ]);
  expect((await listDiskSessions({ limit: 10 }, root)).sessions.map((entry) => entry.id)).toEqual([
    "relative-root",
  ]);
  expect(readHubSessionState(root, "relative-root").sessionId).toBe("relative-root");
  const hub = createHubSessions({
    cwd: f.cwd,
    sessionRootDir: root,
    dataDir: join(f.dir, "relative-hub"),
    isAuthorized: async () => true,
    isRunning: () => false,
    onChanged: () => {},
  });
  expect((await hub.list()).sessions.map((entry) => entry.sessionId)).toEqual(["relative-root"]);
  expect((await scanSessionDirectories()).map((entry) => entry.id)).toContain("relative-root");
  expect(scanSessionDirectoriesSync().map((entry) => entry.id)).toContain("relative-root");
});
