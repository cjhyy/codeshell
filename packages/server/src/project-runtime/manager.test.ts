import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HubSession } from "../hub/auth-store.js";
import { ProjectManager } from "./manager.js";
import { ProjectRegistry } from "./registry.js";
import type {
  ProjectRuntimeConnection,
  ProjectRuntimeProvider,
  ProjectRuntimeRecord,
} from "./types.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});
const session: HubSession = {
  id: "device-one",
  username: "alice",
  deviceName: "test",
  createdAt: 1,
  lastSeenAt: 1,
  expiresAt: Date.now() + 60000,
};
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cs-project-manager-"));
  const registry = new ProjectRegistry(directory);
  const running = new Map<string, ProjectRuntimeConnection>();
  let ensures = 0;
  let gate: (() => Promise<void>) | undefined;
  let active = true;
  const revoked: string[] = [];
  const provider: ProjectRuntimeProvider = {
    availability: async () => ({ available: true }),
    async ensure(record) {
      ensures++;
      await gate?.();
      const target = {
        url: "http://127.0.0.1:9001",
        username: record.runtimeUsername,
        password: record.runtimePassword,
        generation: record.generation,
      };
      running.set(record.id, target);
      return target;
    },
    async stop(record) {
      running.delete(record.id);
    },
    async status(record) {
      return running.has(record.id)
        ? { state: "running", url: running.get(record.id)!.url }
        : { state: "stopped" };
    },
    close: async () => {},
  };
  const manager = new ProjectManager({
    registry,
    provider,
    publicOrigin: () => "http://localhost:8791",
    isSessionActive: () => active,
    revokeProject: async (id) => {
      revoked.push(id);
    },
  });
  cleanup.push(async () => {
    await manager.close();
    registry.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    manager,
    registry,
    provider,
    running,
    revoked,
    directory,
    count: () => ensures,
    revoke: () => {
      active = false;
    },
    pause: (fn: () => Promise<void>) => {
      gate = fn;
    },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("project manager", () => {
  test("coalesces starts, isolates ownership, and keeps data identity across generations", async () => {
    const f = fixture();
    const project = f.manager.create(session, "Work");
    const gate = deferred();
    f.pause(() => gate.promise);
    const first = f.manager.start(session, project.id);
    const second = f.manager.start(session, project.id);
    gate.resolve();
    expect((await first).status).toBe("running");
    expect((await second).generation).toBe(1);
    expect(f.count()).toBe(1);
    expect(() => f.manager.get({ ...session, username: "bob" }, project.id)).toThrow();
    const before = f.registry.get("alice", project.id);
    expect(JSON.stringify(f.manager.list(session))).not.toContain(before.runtimePassword);
    await f.manager.stop(session, project.id);
    await expect(f.manager.resolveTarget(session, project.id)).rejects.toThrow("尚未运行");
    expect((await f.manager.start(session, project.id)).generation).toBe(2);
    const after = f.registry.get("alice", project.id);
    expect(after.ownerId).toBe(before.ownerId);
    expect(after.runtimePassword).toBe(before.runtimePassword);
    expect(f.revoked.length).toBeGreaterThanOrEqual(3);
  });

  test("logout during readiness stops the late runtime and returns no usable target", async () => {
    const f = fixture();
    const project = f.manager.create(session, "Work");
    const gate = deferred();
    f.pause(() => gate.promise);
    const operation = f.manager.start(session, project.id);
    await Promise.resolve();
    f.revoke();
    gate.resolve();
    await expect(operation).rejects.toThrow("登录已过期");
    expect(f.running.size).toBe(0);
    expect(f.registry.get("alice", project.id).status).toBe("stopped");
  });

  test("stop during start wins over a late successful readiness result", async () => {
    const f = fixture();
    const project = f.manager.create(session, "Work");
    const gate = deferred();
    f.pause(() => gate.promise);
    const starting = f.manager.start(session, project.id);
    await Promise.resolve();
    const stopping = f.manager.stop(session, project.id);
    gate.resolve();
    await expect(starting).rejects.toThrow("已取消");
    expect((await stopping).status).toBe("stopped");
    expect(f.running.size).toBe(0);
  });

  test("reserves running quota before asynchronous startup", async () => {
    const f = fixture();
    const projects = Array.from({ length: 5 }, (_, i) => f.manager.create(session, `Project ${i}`));
    const gate = deferred();
    f.pause(() => gate.promise);
    const operations = projects.slice(0, 4).map((project) => f.manager.start(session, project.id));
    await expect(f.manager.start(session, projects[4]!.id)).rejects.toThrow("最多同时运行");
    gate.resolve();
    await Promise.all(operations);
    expect(f.running.size).toBe(4);
  });

  test("crash reconciliation stops known containers before admitting requests", async () => {
    const f = fixture();
    const project = f.manager.create(session, "Work");
    await f.manager.start(session, project.id);
    let stopped: ProjectRuntimeRecord | undefined;
    f.provider.stop = async (record) => {
      stopped = record;
      f.running.delete(record.id);
    };
    await f.manager.reconcile();
    expect(stopped?.id).toBe(project.id);
    expect(f.manager.get(session, project.id).status).toBe("stopped");
    await expect(f.manager.resolveTarget(session, project.id)).rejects.toThrow();
  });

  test("unexpected runtime exit invalidates remembered targets", async () => {
    const f = fixture();
    const project = f.manager.create(session, "Work");
    await f.manager.start(session, project.id);
    f.running.clear();
    await expect(f.manager.resolveTarget(session, project.id)).rejects.toThrow("离线");
    expect(f.manager.get(session, project.id).status).toBe("error");
  });
});
