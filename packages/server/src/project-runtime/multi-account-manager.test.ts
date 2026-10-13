import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRegistry } from "./registry.js";
import { ProjectManager } from "./manager.js";
import type { CloudManagementSession } from "./control-authority.js";
import type { ProjectRuntimeConnection, ProjectRuntimeProvider } from "./types.js";

const origin = "https://accounts.example.test",
  cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture({ maxRunningPerOwner = 2, maxProjectsPerOwner = 16 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "codeshell-multi-manager-")),
    registry = new ProjectRegistry(directory, Date.now, { multiAccountOrigin: origin }),
    running = new Map<string, ProjectRuntimeConnection>(),
    stopped: string[] = [];
  let ensureGate: (() => Promise<void>) | undefined,
    authorityGate: (() => Promise<void>) | undefined,
    failedStop: string | undefined;
  const provider: ProjectRuntimeProvider = {
    availability: async () => ({ available: true }),
    async ensure(record) {
      await ensureGate?.();
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
      stopped.push(record.id);
      if (record.id === failedStop) throw Error("controlled stop failure");
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
    publicOrigin: () => "https://cloud.example.test",
    isSessionActive: () => true,
    revalidateSession: async () => {
      await authorityGate?.();
    },
    revokeProject: async () => {},
    maxRunning: 4,
    maxRunningPerOwner,
    maxProjectsPerOwner,
  });
  const session = (): CloudManagementSession => {
    const accountId = randomUUID();
    return {
      id: randomUUID(),
      kind: "cloud-management",
      audience: "https://cloud.example.test",
      installationId: registry.installationId,
      accountOrigin: origin,
      accountId,
      ownerId: registry.ensureAccountOwner(origin, accountId),
      managementEpoch: registry.multiAccount!.managementEpoch,
      expiresAt: Date.now() + 60000,
    };
  };
  cleanup.push(async () => {
    ensureGate = undefined;
    authorityGate = undefined;
    failedStop = undefined;
    await manager.close();
    registry.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    manager,
    registry,
    running,
    stopped,
    alice: session(),
    bob: session(),
    pauseEnsure: (gate: () => Promise<void>) => {
      ensureGate = gate;
    },
    pauseAuthority: (gate: () => Promise<void>) => {
      authorityGate = gate;
    },
    failStop: (id: string) => {
      failedStop = id;
    },
  };
}

test("owner project and running quotas do not consume another owner's quota", async () => {
  const f = fixture({ maxRunningPerOwner: 1, maxProjectsPerOwner: 2 }),
    first = f.manager.create(f.alice, "A1"),
    second = f.manager.create(f.alice, "A2"),
    third = f.manager.create(f.bob, "B1");
  expect(() => f.manager.create(f.alice, "A3")).toThrow("每个账号最多创建 2");
  expect(() => f.manager.get(f.bob, first.id)).toThrow();
  expect(() => f.manager.list({ ...f.alice, ownerId: randomUUID() })).toThrow();
  await f.manager.start(f.alice, first.id);
  await expect(f.manager.start(f.alice, second.id)).rejects.toThrow("每个账号最多同时运行 1");
  await f.manager.start(f.bob, third.id);
  await f.manager.stopOwner(f.alice.ownerId);
  expect(f.running.has(first.id)).toBe(false);
  expect(f.running.has(third.id)).toBe(true);
  expect(f.manager.get(f.bob, third.id).status).toBe("running");
  expect(f.stopped).not.toContain(third.id);
});

test("owner revocation fences a start waiting for authority before creating any runtime", async () => {
  const f = fixture(),
    project = f.manager.create(f.alice, "Pending"),
    gate = deferred();
  f.pauseAuthority(() => gate.promise);
  const start = f.manager.start(f.alice, project.id);
  void start.catch(() => {});
  await f.manager.stopOwner(f.alice.ownerId);
  gate.resolve();
  await expect(start).rejects.toThrow("启动已取消");
  expect(f.running.size).toBe(0);
  expect(f.manager.get(f.alice, project.id).generation).toBe(0);
});

test("owner revocation stops late runtime readiness while leaving another account running", async () => {
  const f = fixture(),
    a = f.manager.create(f.alice, "Pending A"),
    b = f.manager.create(f.bob, "Running B");
  await f.manager.start(f.bob, b.id);
  const gate = deferred(),
    entered = deferred();
  f.pauseEnsure(async () => {
    entered.resolve();
    await gate.promise;
  });
  const start = f.manager.start(f.alice, a.id);
  void start.catch(() => {});
  await entered.promise;
  const stop = f.manager.stopOwner(f.alice.ownerId);
  gate.resolve();
  await stop;
  await expect(start).rejects.toThrow("启动已取消");
  expect(f.running.has(a.id)).toBe(false);
  expect(f.running.has(b.id)).toBe(true);
  expect(f.manager.get(f.alice, a.id).status).toBe("stopped");
});

test("a failed owner termination reports failure without stopping other accounts", async () => {
  const f = fixture(),
    a = f.manager.create(f.alice, "A"),
    b = f.manager.create(f.bob, "B");
  await f.manager.start(f.alice, a.id);
  await f.manager.start(f.bob, b.id);
  f.failStop(a.id);
  await expect(f.manager.stopOwner(f.alice.ownerId)).rejects.toThrow("部分账号项目尚未确认停止");
  expect(f.manager.get(f.alice, a.id).status).toBe("error");
  expect(f.running.has(b.id)).toBe(true);
  expect(f.stopped).not.toContain(b.id);
});
