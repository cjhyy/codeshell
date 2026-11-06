import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@cjhyy/code-shell-core";
import type { ToolContext } from "@cjhyy/code-shell-core/extension";
import {
  externalRuntimeToolContextForSession,
  externalRuntimeWorkspaceForSession,
} from "./external-runtime-tool-context.js";
import { ProjectStore } from "./project-store.js";
import { SessionCwdIndex } from "./session-cwd-index.js";

const fixtures: string[] = [];
afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function workspaceFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "external-runtime-workspace-")));
  fixtures.push(root);
  const sessionsRoot = join(root, "sessions");
  const sessions = new SessionManager(sessionsRoot);
  const index = new SessionCwdIndex({ sessionsRoot });
  await index.ensureLoaded();
  const projects = new ProjectStore({
    file: join(root, "projects.json"),
    recentsFile: join(root, "recents.json"),
    migrationMarkerFile: join(root, "migration.json"),
    sessionIndex: index,
    sessionManager: sessions,
    noRepoPath: join(root, "no-repo"),
  });
  const dir = (name: string) => {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    return path;
  };
  return { sessions, index, projects, dir };
}

test("external tools retain their session and exact credential approval identity", async () => {
  const calls: unknown[][] = [];
  const panels = new Map<string, NonNullable<ToolContext["panels"]>>();
  const bridge = {
    panelBridgeForSession(sessionId: string) {
      const panel = {} as NonNullable<ToolContext["panels"]>;
      panels.set(sessionId, panel);
      return panel;
    },
    async injectCredentialForSession(...args: [string, string, ("full" | "project")?, string?]) {
      expect(this).toBe(bridge);
      calls.push(args);
      return { ok: false, error: "credential changed after approval" };
    },
  };
  const browser = {} as ToolContext["browser"];
  const workspace = {} as ToolContext["workspace"];
  const first = externalRuntimeToolContextForSession(bridge, "session-a", browser, workspace);
  const second = externalRuntimeToolContextForSession(bridge, "session-b", undefined);
  expect(first.panels).toBe(panels.get("session-a"));
  expect(second.panels).toBe(panels.get("session-b"));
  expect(first.browser).toBe(browser);
  expect(first.workspace).toBe(workspace);
  expect(await first.injectCredentialToBrowser!("account", "project", "approved-record")).toEqual({
    ok: false,
    error: "credential changed after approval",
  });
  await second.injectCredentialToBrowser!("legacy-account");
  expect(calls).toEqual([
    ["session-a", "account", "project", "approved-record"],
    ["session-b", "legacy-account", undefined, undefined],
  ]);
});

test("external workspace uses the bound worktree and refreshes mounted secondary roots", async () => {
  const fixture = await workspaceFixture();
  const primary = fixture.dir("primary");
  const worktree = fixture.dir("worktree");
  const project = await fixture.projects.createFromPath(primary);
  const added = (await fixture.projects.addRoot(project.id, fixture.dir("secondary"))).project;
  const secondary = added.roots.find((root) => root.id !== project.primaryRootId)!;
  fixture.sessions.create(primary, "model", "provider", "external");
  fixture.sessions.updateSessionState("external", {
    project: { projectId: project.id, mainRootId: project.primaryRootId },
    workspace: { kind: "worktree", root: worktree },
  });

  const first = externalRuntimeWorkspaceForSession("external", fixture);
  expect(first.projectId).toBe(project.id);
  expect(first.roots).toEqual([
    { id: project.primaryRootId, path: worktree, role: "primary" },
    { id: secondary.id, path: secondary.path, role: "secondary" },
  ]);
  await fixture.projects.removeRoot(project.id, secondary.id);
  const updated = externalRuntimeWorkspaceForSession("external", fixture);
  expect(updated.roots).toEqual([first.roots[0]!]);
  expect(updated.projectRevision).toBeGreaterThan(first.projectRevision);
  expect(updated.rootsDigest).not.toBe(first.rootsDigest);
});

test("missing Session or removed bound root never falls back to broader workspace authority", async () => {
  const fixture = await workspaceFixture();
  expect(() => externalRuntimeWorkspaceForSession("missing", fixture)).toThrow(/unavailable/);
  const primary = fixture.dir("primary");
  const project = await fixture.projects.createFromPath(primary);
  fixture.sessions.create(primary, "model", "provider", "external");
  fixture.sessions.updateSessionState("external", {
    project: { projectId: project.id, mainRootId: "removed-root" },
  });
  expect(() => externalRuntimeWorkspaceForSession("external", fixture)).toThrow(/root_removed/);
});

test("legacy mounted Sessions retain project roots and unbound Sessions receive only their own root", async () => {
  const fixture = await workspaceFixture();
  const primary = fixture.dir("primary");
  const project = await fixture.projects.createFromPath(primary);
  fixture.sessions.create(primary, "model", "provider", "legacy");
  expect(externalRuntimeWorkspaceForSession("legacy", fixture).projectId).toBe(project.id);
  const unbound = fixture.dir("unbound");
  fixture.sessions.create(unbound, "model", "provider", "unbound");
  expect(externalRuntimeWorkspaceForSession("unbound", fixture).roots).toEqual([
    { id: "legacy-root", path: unbound, role: "primary" },
  ]);
});
