import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { HubSession } from "../hub/auth-store.js";
import { ProjectManager } from "./manager.js";
import { ProjectRegistry } from "./registry.js";
import type { ProjectRuntimeProvider } from "./types.js";
import { startProjectControlServer } from "./control-server.js";

const session: HubSession = {
  id: "browser-one",
  username: "alice",
  deviceName: "test",
  createdAt: 1,
  lastSeenAt: 1,
  expiresAt: Date.now() + 60000,
};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const run of cleanup.splice(0)) await run();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(maxRunning = 4, now = Date.now) {
  const root = mkdtempSync(join(tmpdir(), "codeshell-lifecycle-"));
  const registry = new ProjectRegistry(root);
  let active = true;
  let closed = 0;
  let ensured = 0;
  let revoked: () => Promise<void> = async () => {};
  const stopped: string[] = [];
  const provider: ProjectRuntimeProvider = {
    availability: async () => ({ available: true }),
    ensure: async (record) => {
      ensured++;
      return {
        url: "http://127.0.0.1:49000",
        username: record.runtimeUsername,
        password: record.runtimePassword,
        generation: record.generation,
      };
    },
    stop: async (record) => {
      stopped.push(record.id);
    },
    status: async () => ({ state: "running", url: "http://127.0.0.1:49000" }),
    close: async () => {
      closed++;
    },
  };
  const manager = new ProjectManager({
    registry,
    provider,
    maxRunning,
    now,
    publicOrigin: () => "http://127.0.0.1:8791",
    isSessionActive: () => active,
    revokeProject: () => revoked(),
  });
  cleanup.push(async () => {
    await manager.close().catch(() => {});
    registry.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    registry,
    manager,
    provider,
    stopped,
    closed: () => closed,
    ensured: () => ensured,
    revokeSession: () => {
      active = false;
    },
    revocation: (handler: () => Promise<void>) => {
      revoked = handler;
    },
  };
}

test("failed inner logout cannot bypass actual container termination", async () => {
  const f = fixture();
  const project = f.manager.create(session, "Work");
  await f.manager.start(session, project.id);
  f.revocation(async () => {
    throw new Error("inner runtime logout network failed");
  });
  expect((await f.manager.stop(session, project.id)).status).toBe("stopped");
  expect(f.stopped).toContain(project.id);
  expect(f.manager.get(session, project.id).status).toBe("stopped");
});

test("logout while revoking old project leases prevents even beginning a new Docker start", async () => {
  const f = fixture();
  const project = f.manager.create(session, "Work");
  const gate = deferred();
  f.revocation(() => gate.promise);
  const starting = f.manager.start(session, project.id);
  const outcome = starting.catch((error) => error);
  f.revokeSession();
  gate.resolve();
  expect((await outcome).status).toBe(401);
  expect(f.ensured()).toBe(0);
  expect(f.registry.get("alice", project.id).status).toBe("stopped");
});

test("error-state retries still enforce the configured running quota", async () => {
  const f = fixture(1);
  const first = f.manager.create(session, "One");
  const second = f.manager.create(session, "Two");
  await f.manager.start(session, first.id);
  f.registry.update(second.id, { status: "error", generation: 1 });
  await expect(f.manager.start(session, second.id)).rejects.toMatchObject({ status: 429 });
  expect(f.ensured()).toBe(1);
  expect(f.registry.get("alice", second.id).generation).toBe(1);
});

test("coalesced close waits for termination and always closes provider when stopping fails", async () => {
  const f = fixture();
  const project = f.manager.create(session, "Work");
  await f.manager.start(session, project.id);
  const gate = deferred();
  f.provider.stop = async () => {
    await gate.promise;
    throw new Error("Docker offline");
  };
  const first = f.manager.close();
  const outcome = first.catch((error) => error);
  expect(f.manager.close()).toBe(first);
  expect(f.closed()).toBe(0);
  gate.resolve();
  expect((await outcome).status).toBe(503);
  expect(f.closed()).toBe(1);
  expect(f.registry.get("alice", project.id).status).toBe("error");
});

test("emergency revocation fallback stops every active runtime but leaves never-started project data", async () => {
  const f = fixture();
  const first = f.manager.create(session, "One");
  const second = f.manager.create(session, "Two");
  const fresh = f.manager.create(session, "Later");
  await f.manager.start(session, first.id);
  await f.manager.start(session, second.id);
  f.revocation(async () => {
    throw new Error("logout unreachable");
  });
  await f.manager.stopAll();
  expect(f.stopped.sort()).toEqual([first.id, second.id].sort());
  expect(f.manager.get(session, fresh.id).generation).toBe(0);
  expect(f.manager.list(session)).toHaveLength(3);
  expect(f.manager.list(session).every((project) => project.status === "stopped")).toBe(true);
});

test("a revoked session receives no project result after a long stop finishes", async () => {
  const f = fixture();
  const project = f.manager.create(session, "Work");
  await f.manager.start(session, project.id);
  const gate = deferred();
  f.provider.stop = async (record) => {
    await gate.promise;
    f.stopped.push(record.id);
  };
  const stopping = f.manager.stop(session, project.id);
  const outcome = stopping.catch((error) => error);
  f.revokeSession();
  gate.resolve();
  expect((await outcome).status).toBe(401);
  expect(f.stopped).toContain(project.id);
  expect(f.registry.get("alice", project.id).status).toBe("stopped");
});

test("control startup failure closes provider and releases registry ownership for a later start", async () => {
  const root = mkdtempSync(join(tmpdir(), "codeshell-control-startup-"));
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const address = occupied.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture listener");
  let closed = 0;
  const provider: ProjectRuntimeProvider = {
    availability: async () => ({ available: true }),
    ensure: async () => {
      throw new Error("not started");
    },
    stop: async () => {},
    status: async () => ({ state: "missing" }),
    close: async () => {
      closed++;
    },
  };
  try {
    await expect(
      startProjectControlServer({ host: "127.0.0.1", port: address.port, dataDir: root, provider }),
    ).rejects.toThrow();
    expect(closed).toBe(1);
    const retry = await startProjectControlServer({
      host: "127.0.0.1",
      port: 0,
      dataDir: root,
      provider,
    });
    try {
      expect((await fetch(retry.url + "/health")).status).toBe(200);
    } finally {
      await retry.close();
    }
    expect(closed).toBe(2);
    const registry = new ProjectRegistry(root);
    registry.close();
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("background lease revocation failure stops its project even after logout while other projects remain active", async () => {
  const f = fixture();
  const first = f.manager.create(session, "One");
  const second = f.manager.create(session, "Two");
  await f.manager.start(session, first.id);
  await f.manager.start(session, second.id);
  f.revokeSession();
  f.revocation(async () => {
    throw new Error("inner logout unreachable");
  });
  await f.manager.stopAfterRevocationFailure(first.id);
  expect(f.stopped).toEqual([first.id]);
  expect(f.registry.get("alice", first.id).status).toBe("stopped");
  expect(f.registry.get("alice", second.id).status).toBe("running");
});

test("Docker observations coalesce and expire at two seconds while session and owner checks stay immediate", async () => {
  let now = 0;
  const f = fixture(4, () => now);
  const project = f.manager.create(session, "Work");
  await f.manager.start(session, project.id);
  let checks = 0;
  const gate = deferred();
  f.provider.status = async () => {
    checks++;
    await gate.promise;
    return { state: "running", url: "http://127.0.0.1:49000" };
  };
  const first = f.manager.resolveTarget(session, project.id);
  const second = f.manager.resolveTarget(session, project.id);
  expect(checks).toBe(1);
  gate.resolve();
  await Promise.all([first, second]);
  now = 1999;
  await f.manager.resolveTarget(session, project.id);
  expect(checks).toBe(1);
  now = 2000;
  await f.manager.resolveTarget(session, project.id);
  expect(checks).toBe(2);
  await expect(
    f.manager.resolveTarget({ ...session, username: "bob" }, project.id),
  ).rejects.toMatchObject({ status: 404 });
  f.revokeSession();
  await expect(f.manager.resolveTarget(session, project.id)).rejects.toMatchObject({ status: 401 });
  expect(checks).toBe(2);
});

test("stopping rejects cached targets immediately and a late prior-generation observation cannot replace the new cache", async () => {
  const f = fixture(4, () => 0);
  const project = f.manager.create(session, "Work");
  await f.manager.start(session, project.id);
  let checks = 0;
  const gate = deferred();
  f.provider.status = async () => {
    checks++;
    if (checks === 1) await gate.promise;
    return { state: "running", url: "http://127.0.0.1:49000" };
  };
  const prior = f.manager.resolveTarget(session, project.id).catch((error) => error);
  const stopping = f.manager.stop(session, project.id);
  await expect(f.manager.resolveTarget(session, project.id)).rejects.toMatchObject({ status: 409 });
  await stopping;
  await f.manager.start(session, project.id);
  expect((await f.manager.resolveTarget(session, project.id)).generation).toBe(2);
  expect(checks).toBe(2);
  gate.resolve();
  expect((await prior).status).toBe(409);
  expect((await f.manager.resolveTarget(session, project.id)).generation).toBe(2);
  expect(checks).toBe(2);
});

test("failed Docker observations are never reused", async () => {
  const f = fixture(4, () => 0);
  const project = f.manager.create(session, "Work");
  await f.manager.start(session, project.id);
  let checks = 0;
  f.provider.status = async () => {
    checks++;
    if (checks === 1) throw new Error("temporary Docker inspection failure");
    return { state: "running", url: "http://127.0.0.1:49000" };
  };
  await expect(f.manager.resolveTarget(session, project.id)).rejects.toThrow("temporary Docker");
  expect((await f.manager.resolveTarget(session, project.id)).generation).toBe(1);
  expect(checks).toBe(2);
});
