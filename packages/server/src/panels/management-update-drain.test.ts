import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { panelAppsRoot, SettingsManager } from "@cjhyy/code-shell-core";
import { PanelBackgroundService } from "./background-services.js";
import { panelExecutionGate, type PanelExecutionScope } from "./execution-gate.js";
import { createPanelManagement } from "./management.js";
import { panelAppStoragePath } from "./storage-store.js";

const owner = { ownerId: "desktop:update-drain", authorize: () => true };
let root: string;
let originalHome: string | undefined;
const cleanups: Array<() => void | Promise<void>> = [];

function barrier<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "panel-update-drain-")));
  originalHome = process.env.HOME;
  process.env.HOME = join(root, "home");
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const cwd = join(root, "project");
  const source = join(root, "source");
  mkdirSync(cwd);
  mkdirSync(join(source, ".codeshell-panel"), { recursive: true });
  mkdirSync(join(source, "app"));
  const write = (version: string) => {
    writeFileSync(
      join(source, ".codeshell-panel/panel.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "update-drain-panel",
        version,
        title: { default: "Update drain" },
        entry: "app/index.html",
        placement: "right-dock",
        icon: "panel",
        singleton: true,
        permissions: ["storage"],
      }),
    );
    writeFileSync(join(source, "app/index.html"), version);
  };
  let clock = 100_000;
  let readClock: (() => void) | undefined;
  const changes: string[] = [];
  const api = createPanelManagement({
    cwd,
    allowLocalSources: true,
    projectPackages: true,
    now: () => {
      readClock?.();
      return clock;
    },
    onChanged: (_id, kind) => {
      changes.push(kind);
    },
  });
  cleanups.push(() => api.close());
  write("1.0.0");
  await api.install(
    owner,
    (await api.previewProjectSource(owner, { kind: "dir", path: source })).reviewToken,
  );
  const selected = async () => (await api.snapshot()).panels[0]!;
  const old = await selected();
  write("2.0.0");
  const review = await api.previewProjectUpdate(owner, old.id, old.revision);
  const scope = { appId: old.id, projectPath: cwd, name: "market-feed" };
  const dataPath = panelAppStoragePath(join(root, "data"), old.id, cwd);
  mkdirSync(dirname(dataPath), { recursive: true });
  const data = JSON.stringify({ subscriptions: [], saved: "old guest data" });
  writeFileSync(dataPath, data);
  changes.length = 0;

  // Only the native transport and OS identity observations are injected. The
  // coordinator, durable owner/store, admission gate and Core installer are real.
  const identity = (pid: number) => ({
    pid,
    host: "owned-update-fixture",
    start: String(pid),
    boot: "fixture-boot",
    machine: "fixture-machine",
  });
  let stopping = barrier();
  let exitProof: Promise<boolean> = Promise.resolve(true);
  const workers: Array<{ alive: boolean; pid: number; revision: string; exit(): void }> = [];
  let drains = 0;
  const service = new PanelBackgroundService({
    rootDir: join(root, "services"),
    gate: panelExecutionGate,
    now: () => 100_000,
    identities: { current: identity, status: () => "alive" },
    groupStatus: (value) =>
      workers.find((worker) => worker.pid === value.pid)?.alive ? "unknown" : "dead",
    describe: async () => ({
      revision: (await selected()).revision,
      entry: "feed",
      packageRoot: source,
      cwd,
      executable: "/unused-owned-runtime",
      sha256: "a".repeat(64),
      definition: {
        entry: "feed",
        channels: { quotes: { maxBytes: 1024 } },
        maxLifetimeMs: 21_600_000,
        idleGraceMs: 0,
      },
    }),
    spawn: async (input) => {
      const exited = barrier();
      const worker = {
        alive: true,
        pid: 90_000_000 + workers.length,
        revision: (await selected()).revision,
        exit: () => {
          worker.alive = false;
          exited.resolve();
        },
      };
      workers.push(worker);
      return {
        identity: identity(worker.pid),
        prepare: async () => identity(worker.pid),
        activate: () => input.onLine({ t: "ready" }),
        send() {},
        exited: exited.promise,
        terminate: async () => {
          drains++;
          stopping.resolve();
          const confirmed = await exitProof;
          if (confirmed) worker.exit();
          return confirmed;
        },
      };
    },
  });
  cleanups.push(async () => {
    exitProof = Promise.resolve(true);
    await service.shutdown();
  });
  await service.initialize();
  await service.setDesired(scope, {
    desired: "always",
    expectedRevision: 0,
    requestKey: "start",
  });
  expect(await service.get(scope)).toMatchObject({ desired: "always", phase: "running" });
  expect(workers).toHaveLength(1);
  const unchanged = async () => {
    expect((await selected()).packageDigest).toBe(old.packageDigest);
    expect(readFileSync(dataPath, "utf8")).toBe(data);
    expect(changes).toEqual([]);
  };
  return {
    api,
    cwd,
    old,
    review,
    scope,
    service,
    workers,
    selected,
    write,
    unchanged,
    changes,
    drains: () => drains,
    advance: () => {
      clock += 9 * 60_000;
    },
    onClock: (callback: () => void) => {
      readClock = callback;
    },
    stopWith: (proof: Promise<boolean>) => {
      stopping = barrier();
      exitProof = proof;
      return stopping.promise;
    },
    install: (context = owner) => api.install(context, review.reviewToken),
  };
}

test("ordinary update waits for owned service exit before publishing and resumes the new revision", async () => {
  const f = await fixture();
  const exit = barrier<boolean>();
  const stopping = f.stopWith(exit.promise);
  const pending = f.install();
  try {
    await Promise.race([
      stopping,
      pending.then(() => {
        throw new Error("Published without waiting for the service exit barrier");
      }),
    ]);
    expect(f.drains()).toBe(1);
    expect(f.workers[0]!.alive).toBe(true);
    expect(() => panelExecutionGate.enter(f.scope)).toThrow("正在更新");
    await f.unchanged();
  } finally {
    exit.resolve(true);
    await pending;
  }
  await f.service.tick();
  expect(await f.service.get(f.scope)).toMatchObject({ phase: "running", desired: "always" });
  expect(f.workers).toHaveLength(2);
  expect(f.workers[0]!.alive).toBe(false);
  expect(f.workers[1]!.revision).toBe((await f.selected()).revision);
  expect(f.workers[1]!.revision).not.toBe(f.old.revision);
  expect((await f.selected()).version).toBe("2.0.0");
  expect(f.changes).toEqual(["update"]);
});

for (const invalid of ["source", "stale", "expired", "cancelled", "unauthorized"] as const) {
  test(`ordinary ${invalid} review rejects before draining an always service`, async () => {
    const f = await fixture();
    if (invalid === "source") f.write("3.0.0");
    if (invalid === "stale")
      new SettingsManager(f.cwd, "full").mutateSettingsForScope("project", f.cwd, (settings) => {
        settings.panelAppBindings = [];
      });
    if (invalid === "expired") f.advance();
    if (invalid === "cancelled") f.api.cancelOwner(owner.ownerId);
    await expect(
      f.install(invalid === "unauthorized" ? { ...owner, authorize: () => false } : owner),
    ).rejects.toThrow();
    expect(f.drains()).toBe(0);
    expect(f.workers[0]!.alive).toBe(true);
    await f.unchanged();
    if (invalid === "source") {
      f.write("2.0.0");
      await f.install();
      await f.service.tick();
      expect(f.drains()).toBe(1);
      expect((await f.selected()).version).toBe("2.0.0");
    }
  });
}

for (const boundary of ["prepare", "write"] as const) {
  test(`owner cancellation at the ${boundary} validation continuation cannot cross its lease`, async () => {
    const f = await fixture();
    let reads = 0;
    let cancelled = false;
    f.onClock(() => {
      // prune, each prepare validator's before/after lease reads, then the
      // prepare continuation check and the work validator's before/after reads.
      // Cancellation runs as the chosen async validator returns.
      if (++reads === (boundary === "prepare" ? 5 : 8))
        queueMicrotask(() => {
          cancelled = true;
          f.api.cancelOwner(owner.ownerId);
        });
    });
    await expect(f.install()).rejects.toMatchObject({ status: 401 });
    expect(cancelled).toBe(true);
    expect(f.drains()).toBe(boundary === "prepare" ? 0 : 1);
    if (boundary === "prepare") expect(f.workers[0]!.alive).toBe(true);
    await f.service.tick();
    await f.unchanged();
    expect(f.workers.at(-1)!.revision).toBe(f.old.revision);
  });
}

test("ordinary review expiring during service drain rejects publication and resumes the old revision", async () => {
  const f = await fixture();
  const exit = barrier<boolean>();
  const stopping = f.stopWith(exit.promise);
  const pending = f.install();
  try {
    await Promise.race([
      stopping,
      pending.then(() => {
        throw new Error("Published without waiting for the service exit barrier");
      }),
    ]);
    f.advance();
  } finally {
    exit.resolve(true);
  }
  await expect(pending).rejects.toMatchObject({ status: 409, code: "review_expired" });
  await f.service.tick();
  await f.unchanged();
  expect(f.workers).toHaveLength(2);
  expect(f.workers[1]!.revision).toBe(f.old.revision);
});

test("owner revocation in the staged install authorization callback prevents publication", async () => {
  const f = await fixture();
  let cancelled = false;
  const cancellingOwner = {
    ...owner,
    authorize: () => {
      if (
        !cancelled &&
        readdirSync(panelAppsRoot()).some((name) => name.startsWith(".tmp-update-drain-panel-"))
      ) {
        cancelled = true;
        f.api.cancelOwner(owner.ownerId);
      }
      return true;
    },
  };
  await expect(f.install(cancellingOwner)).rejects.toMatchObject({ status: 401 });
  expect(cancelled).toBe(true);
  await f.service.tick();
  await f.unchanged();
  expect(f.workers.at(-1)!.revision).toBe(f.old.revision);
});

test("stop-unconfirmed retains custody and review until exit is confirmed on retry", async () => {
  const f = await fixture();
  f.stopWith(Promise.resolve(false));
  await expect(f.install()).rejects.toMatchObject({
    status: 409,
    blockers: [{ holder: { kind: "service" } }],
  });
  expect(await f.service.get(f.scope)).toMatchObject({ phase: "stop-unconfirmed" });
  expect(f.workers[0]!.alive).toBe(true);
  expect(f.workers).toHaveLength(1);
  await f.unchanged();
  f.workers[0]!.exit();
  f.stopWith(Promise.resolve(true));
  await f.install();
  await f.service.tick();
  expect((await f.selected()).version).toBe("2.0.0");
  expect(f.workers.at(-1)!.revision).toBe((await f.selected()).revision);
});

test("ordinary update preserves durable tasks, processes and panel calls; only explicit force releases them", async () => {
  const f = await fixture();
  const holders: PanelExecutionScope[] = ["agent-task", "process", "panel-call"].map((kind) => ({
    appId: f.old.id,
    projectPath: f.cwd,
    holder: { kind: kind as "agent-task" | "process" | "panel-call" },
  }));
  const releases = holders.slice(1).map((scope) => panelExecutionGate.enter(scope));
  let queued = true;
  const unregister = panelExecutionGate.register(() => (queued ? [holders[0]!] : []));
  cleanups.push(unregister, ...releases);
  await expect(f.install()).rejects.toMatchObject({ status: 409 });
  const remaining = panelExecutionGate.blockers((scope) => scope.appId === f.old.id);
  for (const holder of holders)
    expect(remaining.some((blocker) => blocker.holder?.kind === holder.holder!.kind)).toBe(true);
  expect(queued).toBe(true);
  await f.unchanged();
  let forceCalls = 0;
  await f.api.install(owner, f.review.reviewToken, true, {
    overwrite: true,
    expectedId: f.old.id,
    releaseExecutions: async (_id, matches) => {
      forceCalls++;
      for (const holder of holders) expect(matches(holder)).toBe(true);
      queued = false;
      for (const release of releases) release();
      await panelExecutionGate.drainServices(matches);
      f.advance(); // Explicit force keeps consent across cancellation's TTL.
    },
  });
  expect(forceCalls).toBe(1);
  expect((await f.selected()).version).toBe("2.0.0");
});

test("force admission still rejects owner revocation after its holders exit", async () => {
  const f = await fixture();
  await expect(
    f.api.install(owner, f.review.reviewToken, true, {
      overwrite: true,
      releaseExecutions: async (_id, matches) => {
        await panelExecutionGate.drainServices(matches);
        f.advance();
        f.api.cancelOwner(owner.ownerId);
      },
    }),
  ).rejects.toMatchObject({ status: 401 });
  await f.service.tick();
  await f.unchanged();
  expect(f.workers.at(-1)!.revision).toBe(f.old.revision);
});

test("publication EACCES resumes the old revision and preserves the same review for retry", async () => {
  const f = await fixture();
  const appRoot = panelAppsRoot();
  const publishRoot = join(appRoot, ".versions", f.old.id);
  let denied = false;
  cleanups.push(() => chmodSync(publishRoot, 0o700));
  const denyingOwner = {
    ...owner,
    authorize: () => {
      // The real installer creates staging before its final authorization guard.
      // Deny retained-package publication, keeping staging's parent writable so
      // cleanup cannot mask the actual rename failure with a second rm failure.
      if (
        !denied &&
        readdirSync(appRoot).some((name) => name.startsWith(".tmp-update-drain-panel-"))
      ) {
        chmodSync(publishRoot, 0o500);
        denied = true;
      }
      return true;
    },
  };
  try {
    await expect(f.install(denyingOwner)).rejects.toMatchObject({
      code: "EACCES",
      syscall: "rename",
    });
  } finally {
    chmodSync(publishRoot, 0o700);
  }
  expect(denied).toBe(true);
  await f.service.tick();
  await f.unchanged();
  expect(f.workers).toHaveLength(2);
  expect(f.workers[1]!.revision).toBe(f.old.revision);
  expect(await f.service.get(f.scope)).toMatchObject({ phase: "running", desired: "always" });
  await f.install();
  await f.service.tick();
  expect((await f.selected()).version).toBe("2.0.0");
  expect(f.workers.at(-1)!.revision).toBe((await f.selected()).revision);
});
