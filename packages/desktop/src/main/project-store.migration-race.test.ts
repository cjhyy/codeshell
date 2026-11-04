import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@cjhyy/code-shell-core";
import { SessionCwdIndex } from "./session-cwd-index.js";
import { ProjectStore } from "./project-store.js";

test("reserves a repair target until the resident migration commits", async () => {
  const root = mkdtempSync(join(tmpdir(), "project-migration-race-"));
  const sessions = join(root, "sessions");
  mkdirSync(sessions);
  const primary = join(root, "primary"),
    secondary = join(root, "secondary");
  mkdirSync(primary);
  mkdirSync(secondary);
  const manager = new SessionManager(sessions);
  const index = new SessionCwdIndex({ sessionsRoot: sessions });
  const store = new ProjectStore({
    file: join(root, "projects.json"),
    recentsFile: join(root, "recents.json"),
    migrationMarkerFile: join(root, "marker.json"),
    sessionIndex: index,
    sessionManager: manager,
    noRepoPath: join(root, "no-repo"),
    resolveProjectRoot: (p) => p,
  });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  try {
    await index.ensureLoaded();
    const project = await store.createFromPath(primary);
    const added = await store.addRoot(project.id, secondary);
    const target = added.project.roots.find((r) => r.id !== project.primaryRootId)!;
    const sessionId = "migration-race";
    manager.create(primary, "fixture", "fixture", sessionId);
    manager.updateSessionState(sessionId, {
      project: { projectId: project.id, mainRootId: project.primaryRootId },
    });
    index.upsert(sessionId, {
      cwd: primary,
      workspaceRoot: primary,
      projectId: project.id,
      mainRootId: project.primaryRootId,
    });
    // Match Desktop's repair UI: the old main folder is no longer mounted.
    rmSync(primary, { recursive: true });
    const migrating = store.migrateSessionMainRoot(sessionId, target.id, {
      owner: {
        async migrate(input) {
          entered();
          await gate;
          manager.migrateSessionMainRoot(
            sessionId,
            { projectId: input.projectId, mainRootId: input.mainRootId },
            input.mainRoot,
          );
          return { status: "migrated", workspace: { root: input.mainRoot, kind: "main" } };
        },
        async complete() {},
      },
    });
    await started;
    await expect(store.removeRoot(project.id, target.id)).rejects.toThrow("in-progress");
    await expect(store.remove(project.id)).rejects.toThrow("in-progress");
    release();
    const migrated = await migrating;
    let error = "";
    try {
      store.resolveRunProjectSync(project.id, sessionId, index.lookupCached(sessionId));
    } catch (e) {
      error = String(e);
    }
    expect(migrated.targetRootId).toBe(target.id);
    expect(manager.readSessionState(sessionId)?.project?.mainRootId).toBe(target.id);
    expect(error).not.toContain("root_removed");
  } finally {
    release();
    rmSync(root, { recursive: true, force: true });
  }
});
