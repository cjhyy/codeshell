import { afterAll, afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { installLocalNetworkGuard } from "../../../../scripts/runtime-cost-smoke-isolation.mjs";

if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME)
  throw new Error("Private HOME required");
const originalFetch = globalThis.fetch;
const originals = [http.request, http.get, https.request, https.get];
const marker = Symbol.for("codeshell.cost-smoke.network-guard");
const previousMarker = Object.getOwnPropertyDescriptor(globalThis, marker);
installLocalNetworkGuard("http://127.0.0.1:9");
expect(() => fetch("https://panel-bookmark.invalid/")).toThrow("non-fixture");
expect(() => http.get("http://127.0.0.1:8/")).toThrow("non-fixture");
afterAll(() => {
  globalThis.fetch = originalFetch;
  [http.request, http.get, https.request, https.get] = originals;
  if (previousMarker) Object.defineProperty(globalThis, marker, previousMarker);
  else delete (globalThis as any)[marker];
  syncBuiltinESMExports();
});

const {
  createPanelDirectoryProjectScope,
  desktopPanelDirectoryBookmarks,
  hubPanelDirectoryBookmarks,
  PanelAppDirectoryBookmarks,
} = await import("./directory-bookmarks.js");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment))
    if (key.toUpperCase().startsWith("GIT_")) delete environment[key];
  return execFileSync("git", ["-c", "core.fsmonitor=false", "-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 3_000,
    maxBuffer: 256 * 1024,
    env: {
      ...environment,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: devNull,
      GIT_OPTIONAL_LOCKS: "0",
    },
  }).trim();
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "panel-bookmark-worktree-")));
  roots.push(root);
  const main = join(root, "main project");
  const worktree = join(root, "linked worktree %20");
  const output = join(root, "chosen output");
  const data = join(root, "host data");
  mkdirSync(main);
  mkdirSync(output);
  mkdirSync(join(main, "nested"));
  writeFileSync(join(main, "nested", "fixture.md"), "fixture");
  git(main, "init", "--initial-branch=main");
  git(main, "add", ".");
  git(
    main,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "initial",
  );
  git(main, "worktree", "add", "--detach", worktree, "HEAD");
  return {
    root,
    main,
    worktree,
    output,
    data,
    current: join(data, "panel-app-directory-bookmarks.json"),
    legacy: join(data, "panel-web-directory-bookmarks.json"),
    admin: git(worktree, "rev-parse", "--absolute-git-dir"),
  };
}

test("Host project proof accepts real main, nested worktrees, and exact non-Git workspaces", () => {
  const f = fixture();
  for (const workspace of [f.main, f.worktree, join(f.worktree, "nested")]) {
    const scope = createPanelDirectoryProjectScope(workspace, f.main);
    expect(scope.projectPath).toBe(f.main);
    expect(() => scope.assertCurrent()).not.toThrow();
  }
  const plain = join(f.root, "plain workspace");
  mkdirSync(plain);
  const scope = createPanelDirectoryProjectScope(plain, plain);
  expect(scope.projectPath).toBe(plain);
  expect(() => scope.assertCurrent()).not.toThrow();
  expect(() => createPanelDirectoryProjectScope(f.worktree, plain)).toThrow();
  expect(() => createPanelDirectoryProjectScope("relative", f.main)).toThrow();
});

test("Desktop restores existing worktree scope across restart without rewriting its ID or record", () => {
  const f = fixture();
  const strict = new PanelAppDirectoryBookmarks(f.current);
  const id = strict.remember("download", f.worktree, f.output);
  const before = readFileSync(f.current, "utf8");
  const desktop = desktopPanelDirectoryBookmarks(f.data);
  expect(desktop.restore("download", f.main, id)).toBe(f.output);
  expect(desktop.restore("download", f.worktree, id)).toBe(f.output);
  expect(desktopPanelDirectoryBookmarks(f.data).restore("download", f.main, id)).toBe(f.output);
  expect(readFileSync(f.current, "utf8")).toBe(before);
  expect(() => strict.restore("download", f.main, id)).toThrow(/unavailable/);
  expect(() => hubPanelDirectoryBookmarks(f.data).restore("download", f.main, id)).toThrow(
    /unavailable/,
  );
  expect(strict.restore("download", f.worktree, id)).toBe(f.output);
});

test("legacy-file import preserves old scope and ID alongside a new main-project bookmark", () => {
  const f = fixture();
  const old = new PanelAppDirectoryBookmarks(f.legacy);
  const id = old.remember("download", f.worktree, f.output);
  const before = readFileSync(f.legacy, "utf8");
  const record = JSON.parse(before).bookmarks[0];
  const desktop = desktopPanelDirectoryBookmarks(f.data);
  expect(desktop.restore("download", f.main, id)).toBe(f.output);
  expect(JSON.parse(readFileSync(f.current, "utf8")).bookmarks).toEqual([record]);
  expect(readFileSync(f.legacy, "utf8")).toBe(before);
  const mainId = desktop.remember("download", f.main, f.output);
  expect(mainId).not.toBe(id);
  expect(desktop.remember("download", f.main, f.output)).toBe(mainId);
  const restarted = desktopPanelDirectoryBookmarks(f.data);
  expect(restarted.restore("download", f.main, id)).toBe(f.output);
  expect(restarted.restore("download", f.main, mainId)).toBe(f.output);
  expect(new PanelAppDirectoryBookmarks(f.current).restore("download", f.worktree, id)).toBe(
    f.output,
  );
  expect(JSON.parse(readFileSync(f.current, "utf8")).bookmarks).toContainEqual(record);
  expect(readFileSync(f.legacy, "utf8")).toBe(before);
});

test("cross-Panel, cross-project, and one-way forged Git pointers cannot restore legacy grants", () => {
  const f = fixture();
  const old = new PanelAppDirectoryBookmarks(f.current);
  const id = old.remember("download", f.worktree, f.output);
  const desktop = desktopPanelDirectoryBookmarks(f.data);
  expect(() => desktop.restore("other-panel", f.main, id)).toThrow(/unavailable/);
  const unrelated = join(f.root, "unrelated project");
  mkdirSync(unrelated);
  git(unrelated, "init", "--initial-branch=main");
  expect(() => desktop.restore("download", unrelated, id)).toThrow(/unavailable/);
  const forged = join(f.root, "forged worktree");
  mkdirSync(forged);
  writeFileSync(join(forged, ".git"), readFileSync(join(f.worktree, ".git")));
  const forgedId = old.remember("download", forged, f.output);
  expect(() => desktop.restore("download", f.main, forgedId)).toThrow(/unavailable/);
  expect(() => createPanelDirectoryProjectScope(forged, f.main)).toThrow();
});

test("the Host alias callback is never used for exact scope or a different Panel", () => {
  const f = fixture();
  let proofs = 0;
  const store = new PanelAppDirectoryBookmarks(f.current, {
    isLegacyProjectScope() {
      proofs++;
      throw new Error("refused proof");
    },
  });
  const id = store.remember("download", f.worktree, f.output);
  expect(store.restore("download", f.worktree, id)).toBe(f.output);
  expect(() => store.restore("other-panel", f.main, id)).toThrow(/unavailable/);
  expect(proofs).toBe(0);
  expect(() => store.restore("download", f.main, id)).toThrow(/unavailable/);
  expect(proofs).toBe(1);
});

test.each(["worktree pointer", "admin backpointer", "commondir", "pointer inode"])(
  "a cached legacy association refuses later changes to %s",
  (change) => {
    const f = fixture();
    const id = new PanelAppDirectoryBookmarks(f.current).remember("download", f.worktree, f.output);
    const before = readFileSync(f.current, "utf8");
    const desktop = desktopPanelDirectoryBookmarks(f.data);
    expect(desktop.restore("download", f.main, id)).toBe(f.output);
    if (change === "worktree pointer")
      writeFileSync(join(f.worktree, ".git"), "gitdir: /unrelated/.git/worktrees/fake\n");
    else if (change === "admin backpointer")
      writeFileSync(join(f.admin, "gitdir"), join(f.root, "foreign/.git") + "\n");
    else if (change === "commondir")
      writeFileSync(join(f.admin, "commondir"), "../../../foreign\n");
    else {
      const pointer = join(f.worktree, ".git");
      const content = readFileSync(pointer);
      renameSync(pointer, pointer + ".old");
      writeFileSync(pointer, content);
    }
    expect(() => desktop.restore("download", f.main, id)).toThrow(/unavailable/);
    expect(readFileSync(f.current, "utf8")).toBe(before);
  },
);

test.each(["replace worktree", "delete worktree", "replace main"])(
  "frozen project proof and legacy restore refuse %s",
  (change) => {
    const f = fixture();
    const proof = createPanelDirectoryProjectScope(f.worktree, f.main);
    const id = new PanelAppDirectoryBookmarks(f.current).remember("download", f.worktree, f.output);
    const desktop = desktopPanelDirectoryBookmarks(f.data);
    expect(desktop.restore("download", f.main, id)).toBe(f.output);
    if (change === "delete worktree") rmSync(f.worktree, { recursive: true });
    else {
      const directory = change === "replace worktree" ? f.worktree : f.main;
      renameSync(directory, directory + ".old");
      mkdirSync(directory);
    }
    expect(() => proof.assertCurrent()).toThrow();
    expect(() => desktop.restore("download", f.main, id)).toThrow(/unavailable/);
  },
);

test("verified worktree scope cannot bypass selected-directory replacement or symlinks", () => {
  const f = fixture();
  const id = new PanelAppDirectoryBookmarks(f.current).remember("download", f.worktree, f.output);
  const desktop = desktopPanelDirectoryBookmarks(f.data);
  expect(desktop.restore("download", f.main, id)).toBe(f.output);
  renameSync(f.output, f.output + ".old");
  mkdirSync(f.output);
  expect(() => desktop.restore("download", f.main, id)).toThrow(/changed/);
  rmSync(f.output, { recursive: true });
  symlinkSync(f.output + ".old", f.output);
  expect(() => desktop.restore("download", f.main, id)).toThrow(/changed/);
});

test("a conflicting current ID cannot be replaced by a legacy worktree record", () => {
  const f = fixture();
  const id = new PanelAppDirectoryBookmarks(f.legacy).remember("download", f.worktree, f.output);
  const legacy = JSON.parse(readFileSync(f.legacy, "utf8"));
  const current = { version: 1, bookmarks: [{ ...legacy.bookmarks[0], appId: "other-panel" }] };
  writeFileSync(f.current, JSON.stringify(current));
  const before = readFileSync(f.current, "utf8");
  expect(() => desktopPanelDirectoryBookmarks(f.data).restore("download", f.main, id)).toThrow(
    /unavailable/,
  );
  expect(readFileSync(f.current, "utf8")).toBe(before);
});
