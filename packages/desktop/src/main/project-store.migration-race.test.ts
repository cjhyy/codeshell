import { withdrawRootMigration } from "@cjhyy/code-shell-core/internal/storage";
import { randomUUID } from "node:crypto";
import { StoredProjectMigrations } from "../host/composition/stored-project-migrations.js";
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
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

test("the registry remains responsive during Engine handoff and checks the document at the offline CAS", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "hosted-migration-")));
  const sessions = join(directory, "sessions");
  const source = join(directory, "source");
  const target = join(directory, "target");
  for (const path of [sessions, source, target]) mkdirSync(path);
  const sessionManager = new SessionManager(sessions);
  const store = new ProjectStore({
    sessionManager,
    sessionIndex: new SessionCwdIndex({ sessionsRoot: sessions }),
    file: join(directory, "projects.json"),
    recentsFile: join(directory, "recents.json"),
    migrationMarkerFile: join(directory, "marker"),
    noRepoPath: join(directory, "no-repo"),
    resolveProjectRoot: (path) => path,
  });
  const reservations = new StoredProjectMigrations(store, sessions);
  const sessionId = "hosted-migration";
  const project = await store.createFromPath(source);
  const added = await store.addRoot(project.id, target);
  const targetRootId = added.project.roots.find((root) => root.id !== project.primaryRootId)!.id;
  sessionManager.create(source, "fixture", "fixture", sessionId);
  sessionManager.updateSessionState(sessionId, {
    project: { projectId: project.id, mainRootId: project.primaryRootId },
  });
  const ticket = randomUUID();
  try {
    const admitted = await reservations.prepare({ ticket, sessionId, targetRootId }, () => {});
    expect(admitted.mainRoot).toBe(target);
    await expect(store.remove(project.id)).rejects.toThrow("in-progress");
    await expect(store.removeRoot(project.id, targetRootId)).rejects.toThrow("in-progress");
    const owner = { status: "not-resident" as const, ownershipToken: "owned-claim" };
    await expect(
      reservations.settle({ ticket, outcome: owner }, () => {
        throw Error("document left");
      }),
    ).rejects.toThrow("document left");
    expect(sessionManager.readSessionState(sessionId)?.project?.mainRootId).toBe(
      project.primaryRootId,
    );
    await reservations.release(ticket);
    expect(() => reservations.settle({ ticket, outcome: owner }, () => {})).toThrow("expired");

    const withdrawn = randomUUID();
    await reservations.prepare({ ticket: withdrawn, sessionId, targetRootId }, () => {});
    await withdrawRootMigration(sessions, sessionId, withdrawn);
    expect(() =>
      sessionManager.migrateSessionMainRoot(
        sessionId,
        { projectId: project.id, mainRootId: targetRootId },
        target,
        withdrawn,
      ),
    ).toThrow("revoked");
    await expect(
      reservations.settle({ ticket: withdrawn, outcome: owner }, () => {}),
    ).rejects.toThrow("revoked");
    expect(sessionManager.readSessionState(sessionId)?.project?.mainRootId).toBe(
      project.primaryRootId,
    );
    await reservations.release(withdrawn);

    const another = randomUUID();
    await reservations.prepare({ ticket: another, sessionId, targetRootId }, () => {});
    sessionManager.migrateSessionMainRoot(
      sessionId,
      { projectId: project.id, mainRootId: targetRootId },
      target,
      another,
    );
    expect(() =>
      sessionManager.migrateSessionMainRoot(
        sessionId,
        { projectId: project.id, mainRootId: targetRootId },
        target,
        another,
      ),
    ).toThrow("revoked");
    const recovered = await reservations.settle(
      { ticket: another, outcome: { status: "response-lost", message: "Engine exited" } },
      () => {
        throw Error("a committed Engine must never be invoked again");
      },
    );
    expect(recovered.workspace.root).toBe(target);
    await reservations.release(another);
    await expect(store.removeRoot(project.id, targetRootId)).rejects.toThrow(sessionId);
  } finally {
    await reservations.release(ticket);
    rmSync(directory, { recursive: true, force: true });
  }
});
