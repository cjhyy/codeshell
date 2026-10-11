import { afterAll, afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardProjectScopeNetwork } from "../../../server/src/panels/__fixtures__/project-scope-network.js";

guardProjectScopeNetwork(afterAll);
const { ProjectStore } = await import("./project-store.js");
const { SessionCwdIndex } = await import("./session-cwd-index.js");
const { createDesktopPanelProjectScopeResolver } = await import("./panel-project-scope.js");
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "desktop-panel-project-scope-")));
  roots.push(root);
  const cwd = join(root, "first");
  mkdirSync(cwd);
  const file = join(root, "registry", "projects.json");
  const store = new ProjectStore({
    file,
    recentsFile: join(root, "registry", "recents.json"),
    migrationMarkerFile: join(root, "registry", "migration.json"),
    sessionIndex: new SessionCwdIndex({ sessionsRoot: join(root, "sessions") }),
    noRepoPath: join(root, "no-repo"),
  });
  const project = await store.createFromPath(cwd);
  const resolve = createDesktopPanelProjectScopeResolver({
    store,
    environmentDir: join(root, "desktop"),
  });
  return { root, cwd, file, store, project, resolve };
}

test("native and paired composition share the exact registered scope independent of Session", async () => {
  const f = await fixture();
  const native = await f.resolve(f.cwd, f.cwd);
  const paired = await createDesktopPanelProjectScopeResolver({
    store: f.store,
    environmentDir: join(f.root, "desktop"),
  })(f.cwd, f.cwd);
  expect(native?.scope).toEqual(paired?.scope);
  expect(native?.scope.projectId).toBe(f.project.id);
  expect(native?.scope).not.toHaveProperty("sessionId");
  native!.assertCurrent();
  const unknown = join(f.root, "unregistered");
  mkdirSync(unknown);
  expect(await f.resolve(unknown, unknown)).toBeUndefined();
});

test("each registered root keeps its own execution identity within one project", async () => {
  const f = await fixture();
  const other = join(f.root, "second");
  mkdirSync(other);
  await f.store.addRoot(f.project.id, other);
  const one = await f.resolve(f.cwd, f.cwd);
  const two = await f.resolve(other, other);
  expect(one!.scope.projectId).toBe(two!.scope.projectId);
  expect(one!.scope.rootId).not.toBe(two!.scope.rootId);
});

test("project deletion/recreation or root ID changes cannot rebind an existing scope", async () => {
  const f = await fixture();
  const original = await f.resolve(f.cwd, f.cwd);
  const registry = JSON.parse(readFileSync(f.file, "utf8"));
  registry.projects[0].roots[0].id = "replacement-root-id";
  registry.projects[0].primaryRootId = "replacement-root-id";
  writeFileSync(f.file, JSON.stringify(registry));
  expect(() => original!.assertCurrent()).toThrow();
  const changed = await f.resolve(f.cwd, f.cwd);
  expect(changed!.scope.rootId).not.toBe(original!.scope.rootId);
  await f.store.remove(f.project.id);
  expect(() => changed!.assertCurrent()).toThrow();
  expect(await f.resolve(f.cwd, f.cwd)).toBeUndefined();
});

test("same-path mount replacement never inherits the existing scope", async () => {
  const f = await fixture();
  const old = await f.resolve(f.cwd, f.cwd);
  renameSync(f.cwd, f.cwd + "-old");
  mkdirSync(f.cwd);
  expect(() => old!.assertCurrent()).toThrow();
  expect((await f.resolve(f.cwd, f.cwd))!.scope.rootId).not.toBe(old!.scope.rootId);
});

test("real Git worktrees share project identity and have distinct execution roots", async () => {
  const f = await fixture();
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", f.cwd, ...args], {
      encoding: "utf8",
      timeout: 3_000,
      stdio: "pipe",
    });
  git("init", "--initial-branch=main");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  const worktree = join(f.root, "worktree");
  git("worktree", "add", "-b", "fixture", worktree);
  const main = await f.resolve(f.cwd, f.cwd);
  const linked = await f.resolve(f.cwd, worktree);
  expect(main!.scope.projectId).toBe(linked!.scope.projectId);
  expect(main!.scope.rootId).not.toBe(linked!.scope.rootId);
  writeFileSync(join(worktree, ".git"), "gitdir: /forged/worktrees/fixture\n");
  expect(() => linked!.assertCurrent()).toThrow();
  await expect(f.resolve(f.cwd, worktree)).rejects.toThrow();
});
