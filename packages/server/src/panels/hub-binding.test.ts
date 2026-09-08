import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHubPanelBinding } from "./hub-binding.js";
import {
  installReviewedLocalPanelApp,
  previewLocalPanelApp,
  scanSkills,
  invalidateSkillCache,
} from "@cjhyy/code-shell-core";
import { startHeadlessServer, type HeadlessServer } from "../serve/headless-server.js";

let root: string;
let main: string;
let worktree: string;
let previousHome: string | undefined;
const servers: HeadlessServer[] = [];

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cs-hub-panel-binding-")));
  main = join(root, "main project");
  worktree = join(root, "linked worktree %20");
  mkdirSync(join(main, "nested"), { recursive: true });
  writeFileSync(join(main, "nested/file.md"), "fixture");
  git(main, "init", "--initial-branch=main");
  git(main, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", ".");
  git(
    main,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "initial",
  );
  git(main, "worktree", "add", "--detach", worktree, "HEAD");
  previousHome = process.env.HOME;
  process.env.HOME = join(root, "home");
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  invalidateSkillCache();
  rmSync(root, { recursive: true, force: true });
});

test("a normal repository, nested directory, and linked worktree share the main binding", () => {
  for (const cwd of [main, join(main, "nested"), worktree, join(worktree, "nested")]) {
    const binding = createHubPanelBinding(cwd);
    expect(binding.bindingCwd).toBe(main);
    expect(() => binding.assertBinding()).not.toThrow();
  }
});

test("non-Git workspaces do not need Git and an unverified repository only disables panels", () => {
  const cwd = join(root, "plain workspace");
  mkdirSync(cwd);
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = join(root, "empty-path");
    const plain = createHubPanelBinding(cwd);
    expect(plain.bindingCwd).toBe(cwd);
    expect(() => plain.assertBinding()).not.toThrow();
    const unchecked = createHubPanelBinding(main);
    expect(() => unchecked.assertBinding()).toThrow(/无法核验面板所属项目/);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("forged worktree pointers and symlinked git entries cannot authorize a foreign project", () => {
  const forged = join(root, "forged");
  mkdirSync(forged);
  writeFileSync(join(forged, ".git"), readFileSync(join(worktree, ".git")));
  expect(() => createHubPanelBinding(forged).assertBinding()).toThrow(/无法核验/);
  rmSync(join(forged, ".git"));
  symlinkSync(join(main, ".git"), join(forged, ".git"));
  expect(() => createHubPanelBinding(forged).assertBinding()).toThrow(/无法核验/);
});

test("frozen bindings reject later pointer retargeting and replacement without following it", () => {
  const binding = createHubPanelBinding(worktree);
  binding.assertBinding();
  writeFileSync(join(worktree, ".git"), "gitdir: /unrelated/.git/worktrees/fake\n");
  expect(() => binding.assertBinding()).toThrow(/关联已经变化/);
  expect(binding.bindingCwd).toBe(main);
  const cwd = join(root, "plain");
  mkdirSync(cwd);
  const plain = createHubPanelBinding(cwd);
  writeFileSync(join(cwd, ".git"), readFileSync(join(worktree, ".git")));
  expect(() => plain.assertBinding()).toThrow(/关联已经变化/);
});

test("initializing Git in the same previously plain workspace preserves its exact binding", () => {
  const cwd = join(root, "plain");
  mkdirSync(cwd);
  const binding = createHubPanelBinding(cwd);
  git(cwd, "init", "--initial-branch=main");
  expect(() => binding.assertBinding()).not.toThrow();
  expect(binding.bindingCwd).toBe(cwd);
});

test("ambient Git directory overrides cannot influence the selected workspace", () => {
  const previous = process.env.GIT_DIR;
  const previousTree = process.env.GIT_WORK_TREE;
  try {
    process.env.GIT_DIR = "/not-the-selected-repository";
    process.env.GIT_WORK_TREE = "/not-the-selected-workspace";
    const binding = createHubPanelBinding(join(main, "nested"));
    expect(binding.bindingCwd).toBe(main);
    expect(() => binding.assertBinding()).not.toThrow();
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
    if (previousTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = previousTree;
  }
});

test("the real Hub binds in the main project, exposes the same Core Skills, and refuses changed Git pointers", async () => {
  const source = join(root, "panel-source");
  for (const path of [".codeshell-panel", "app", "agent/skills/fixture"])
    mkdirSync(join(source, path), { recursive: true });
  writeFileSync(
    join(source, ".codeshell-panel/panel.json"),
    JSON.stringify({
      schemaVersion: 2,
      id: "binding-panel",
      version: "1.0.0",
      title: { default: "Binding panel" },
      entry: "app/index.html",
      icon: "panel",
      singleton: true,
      placement: "right-dock",
      permissions: ["context.workspace", "storage"],
      agent: { tools: [], skills: ["agent/skills/fixture/SKILL.md"] },
    }),
  );
  writeFileSync(join(source, "app/index.html"), "<!doctype html><body>Fixture</body>");
  writeFileSync(
    join(source, "agent/skills/fixture/SKILL.md"),
    "---\nname: fixture\ndescription: Fixture panel Skill.\n---\nUse the fixture.\n",
  );
  const reviewed = await previewLocalPanelApp({ kind: "dir", path: source });
  await installReviewedLocalPanelApp(
    { kind: "dir", path: source },
    reviewed.reviewToken,
    new Date().toISOString(),
  );
  const server = await startHeadlessServer({
    cwd: join(worktree, "nested"),
    dataDir: join(root, "hub-data"),
    workerEntryPath: join(root, "unused-worker.js"),
    authMode: "hub",
    port: 0,
  });
  servers.push(server);
  const login = await fetch(server.url + "/api/v1/auth/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: server.url },
    body: JSON.stringify({
      token: server.bootstrapToken,
      username: "fixture",
      password: "synthetic-panel-binding-password",
    }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
  const headers = { Cookie: cookie, Origin: server.url };
  const initial = await fetch(server.url + "/api/v1/panels", { headers });
  expect(initial.status).toBe(200);
  const snapshot = (await initial.json()) as {
    workspace: string;
    panels: Array<{ id: string; revision: string; bound: boolean }>;
  };
  expect(snapshot.workspace).toBe(main);
  const panel = snapshot.panels[0]!;
  const change = await fetch(server.url + `/api/v1/panels/${panel.id}/binding`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ bound: true, expectedRevision: panel.revision }),
  });
  expect(change.status).toBe(200);
  expect(
    JSON.parse(readFileSync(join(main, ".code-shell/settings.json"), "utf8")).panelAppBindings,
  ).toContain("binding-panel");
  expect(existsSync(join(worktree, "nested/.code-shell/settings.json"))).toBe(false);
  for (const cwd of [main, worktree, join(worktree, "nested")])
    expect(scanSkills(cwd).some((skill) => skill.name === "binding-panel:fixture")).toBe(true);
  const current = ((await change.json()) as typeof snapshot).panels[0]!;
  const saved = readFileSync(join(main, ".code-shell/settings.json"), "utf8");
  writeFileSync(join(worktree, ".git"), "gitdir: /unrelated/.git/worktrees/fake\n");
  expect((await fetch(server.url + "/api/v1/panels", { headers })).status).toBe(403);
  expect(
    (
      await fetch(server.url + `/api/v1/panels/${panel.id}/binding`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ bound: false, expectedRevision: current.revision }),
      })
    ).status,
  ).toBe(403);
  expect(readFileSync(join(main, ".code-shell/settings.json"), "utf8")).toBe(saved);
  expect((await fetch(server.url + "/api/v1/auth/status", { headers })).status).toBe(200);
});
