import { describe, expect, spyOn, test } from "bun:test";
import type { Engine } from "../engine/engine.js";
import { createWorkspaceContext } from "../workspace/workspace-context.js";
import { ChatSessionManager } from "./chat-session-manager.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(dispose?: () => Promise<void>) {
  const engines: Engine[] = [];
  const manager = new ChatSessionManager({
    runtime: {} as never,
    engineFactory() {
      const engine = {
        migrateSessionMainRoot: (_id: string, _project: unknown, root: string) => ({
          root,
          kind: "main",
        }),
        dispose: engines.length === 0 ? dispose : undefined,
      } as unknown as Engine;
      engines.push(engine);
      return engine;
    },
  });
  return { manager, engines };
}

describe("ChatSessionManager internal Session access", () => {
  test("does not reopen a target closed while dispatch was waiting for migration", async () => {
    const { manager, engines } = fixture();
    manager.beginSessionMigration("target", "ownership");
    const opening = manager.getOrCreate("target", {}, { allowReopen: false });

    await manager.close("target");
    manager.completeSessionMigration("target", "ownership");

    await expect(opening).rejects.toThrow("closing or closed");
    expect(manager.isClosed("target")).toBe(true);
    expect(manager.get("target")).toBeUndefined();
    expect(engines).toEqual([]);
  });

  test("cancels migration waits immediately and removes their abort listener", async () => {
    const { manager, engines } = fixture();
    manager.beginSessionMigration("target", "ownership");
    const controller = new AbortController();
    const added = spyOn(controller.signal, "addEventListener");
    const removed = spyOn(controller.signal, "removeEventListener");
    try {
      const opening = manager.getOrCreate(
        "target",
        {},
        {
          allowReopen: false,
          signal: controller.signal,
        },
      );
      controller.abort(new Error("sender disconnected"));

      await expect(opening).rejects.toThrow("sender disconnected");
      expect(added).toHaveBeenCalledTimes(1);
      expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0]![1]);
      expect(engines).toEqual([]);

      manager.completeSessionMigration("target", "ownership");
      await Promise.resolve();
      expect(manager.get("target")).toBeUndefined();
      expect(engines).toEqual([]);
    } finally {
      added.mockRestore();
      removed.mockRestore();
      manager.completeSessionMigration("target", "ownership");
    }
  });

  test("checks cancellation again when a migration releases before the waiter resumes", async () => {
    const { manager, engines } = fixture();
    manager.beginSessionMigration("target", "ownership");
    const controller = new AbortController();
    const opening = manager.getOrCreate("target", {}, { signal: controller.signal });
    manager.completeSessionMigration("target", "ownership");
    controller.abort(new Error("cancel before creating"));

    await expect(opening).rejects.toThrow("cancel before creating");
    expect(engines).toEqual([]);
  });

  test("rejects an already aborted caller before constructing an Engine", async () => {
    const { manager, engines } = fixture();
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));

    await expect(manager.getOrCreate("target", {}, { signal: controller.signal })).rejects.toThrow(
      "already cancelled",
    );
    expect(engines).toEqual([]);
  });

  test("removes the abort listener after migration completes successfully", async () => {
    const { manager, engines } = fixture();
    manager.beginSessionMigration("target", "ownership");
    const controller = new AbortController();
    const added = spyOn(controller.signal, "addEventListener");
    const removed = spyOn(controller.signal, "removeEventListener");
    try {
      const opening = manager.getOrCreate("target", {}, { signal: controller.signal });
      manager.completeSessionMigration("target", "ownership");
      expect(await opening).toBe(manager.get("target")!);
      expect(engines).toHaveLength(1);
      expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0]![1]);
    } finally {
      added.mockRestore();
      removed.mockRestore();
      await manager.close("target");
    }
  });

  test("keeps explicit user reopening enabled by default", async () => {
    const { manager, engines } = fixture();
    await manager.close("target");
    await expect(manager.getOrCreate("target", {}, { allowReopen: false })).rejects.toThrow(
      "closing or closed",
    );

    const reopened = await manager.getOrCreate("target", {});
    expect(manager.get("target")).toBe(reopened);
    expect(manager.isClosed("target")).toBe(false);
    expect(engines).toHaveLength(1);
    await manager.close("target");
  });

  test("publishes a close requested during resident migration before any waiting sender can acquire it", async () => {
    const disposal = deferred();
    const { manager, engines } = fixture(() => disposal.promise);
    const original = await manager.getOrCreate("target", { cwd: "/before" });
    const migrating = manager.migrateResidentSessionMainRoot("target", {
      project: { projectId: "project", mainRootId: "root" },
      mainRoot: "/after",
      workspaceContext: createWorkspaceContext({
        projectId: "project",
        projectRevision: 1,
        sessionMainRootId: "root",
        roots: [{ id: "root", path: "/after", role: "primary" }],
      }),
      projectTrusted: true,
    });
    const opening = manager.getOrCreate("target", {}, { allowReopen: false });
    const closing = manager.close("target");
    expect(manager.isClosing("target")).toBe(true);
    expect(manager.close("target")).toBe(closing);
    const userReopening = manager.getOrCreate("target", {});

    disposal.resolve();
    await migrating;
    await expect(opening).rejects.toThrow("closing or closed");
    await closing;
    const reopened = await userReopening;

    expect(reopened).not.toBe(original);
    expect(engines).toHaveLength(3);
    expect(manager.isClosing("target")).toBe(false);
    await manager.close("target");
  });
});
