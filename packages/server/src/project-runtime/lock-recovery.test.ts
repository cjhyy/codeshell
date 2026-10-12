import { afterAll, afterEach, expect, test } from "bun:test";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { installCloudControlConfinement } from "./__fixtures__/cloud-control-confinement.js";

// This exact fixture child is the only captured process capability. Product
// imports see deny-all process/network guards before Core initializes.
const spawnOwned = childProcess.spawn.bind(childProcess);
const spawnSyncOwned = childProcess.spawnSync.bind(childProcess);
const confinement = installCloudControlConfinement();
afterAll(() => confinement.restore());
const { acquireProjectControllerLock } = await import("./lock.js");
const { ProjectRegistry } = await import("./registry.js");
const { adoptCloudAccount } = await import("./account-adoption.js");
const { backupProjectInstallation } = await import("./backup.js");
const { startProjectControlServer } = await import("./control-server.js");
const { HubAuthStore } = await import("../hub/auth-store.js");
const { CLOUD_ADOPTION_PENDING } = await import("./account-binding.js");

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of cleanups.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Controller fixture cleanup failed.");
});
function directory() {
  const root = realpathSync(mkdtempSync(join(process.env.HOME!, "controller-lease-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const control = join(root, "project-control");
  mkdirSync(control, { mode: 0o700 });
  return { root, control };
}
function replaceLock(control: string) {
  const path = control + ".lock";
  const original = lstatSync(path);
  renameSync(path, path + ".original");
  mkdirSync(path, { mode: 0o700 });
  // Defeat a check based only on proper-lockfile's mtime: ownership is an inode.
  utimesSync(path, original.atime, original.mtime);
  return lstatSync(path);
}
async function ownedController(control: string) {
  const child = spawnOwned(
    process.execPath,
    [fileURLToPath(new URL("./__fixtures__/controller-lock-owner.mjs", import.meta.url)), control],
    { env: process.env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  let stderr = "";
  child.stderr.on("data", (part) => (stderr = (stderr + part).slice(-4000)));
  const messages: unknown[] = [];
  let receive: ((value: unknown) => void) | undefined;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const value: unknown = JSON.parse(line);
    if (receive) {
      const resolve = receive;
      receive = undefined;
      resolve(value);
    } else messages.push(value);
  });
  const next = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        messages.length
          ? Promise.resolve(messages.shift())
          : new Promise((done) => (receive = done)),
        ended.then(() => {
          throw new Error(`Owned controller exited before its receipt: ${stderr}`);
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Owned controller receipt timed out.")), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  let closed = false;
  const close = async () => {
    if (closed) return;
    try {
      child.stdin.end("close\n");
      expect(await next()).toEqual({ closed: true });
      expect(await ended).toEqual({ code: 0, signal: null });
      closed = true;
    } finally {
      if (!closed) {
        child.kill("SIGKILL");
        await ended;
        closed = true;
      }
      lines.close();
    }
  };
  cleanups.push(close);
  expect(await next()).toMatchObject({ ready: true, pid: child.pid });
  return {
    close,
    async check() {
      child.stdin.write("check\n");
      expect(await next()).toEqual({ held: true });
    },
  };
}

test("a missing control directory permanently invalidates its lease even after the original inode returns", () => {
  const { control } = directory();
  const lock = acquireProjectControllerLock(control);
  cleanups.push(() => lock.release());
  renameSync(control, control + ".away");
  expect(() => lock.assertHeld()).toThrow();
  renameSync(control + ".away", control);
  expect(() => lock.assertHeld()).toThrow();
});

test("a genuinely stale sibling lock is reclaimed and a healthy owner releases its own replacement", () => {
  const { control } = directory();
  const path = control + ".lock";
  mkdirSync(path, { mode: 0o700 });
  const stale = new Date(Date.now() - 60_000);
  utimesSync(path, stale, stale);
  const lock = acquireProjectControllerLock(control);
  cleanups.push(() => lock.release());
  lock.assertHeld();
  expect(lstatSync(path).mtimeMs).toBeGreaterThan(stale.getTime());
  lock.release();
  expect(existsSync(path)).toBe(false);
});

test("a stale current marker is reclaimed while unknown, unsafe, and multiple markers are preserved", () => {
  for (const kind of ["current", "unknown", "multiple", "unsafe"] as const) {
    const { control } = directory();
    const path = control + ".lock";
    mkdirSync(path, { mode: 0o700 });
    const name = `.owner-${randomUUID()}`;
    writeFileSync(join(path, kind === "unknown" ? "unrecognized-owner" : name), "", {
      mode: kind === "unsafe" ? 0o644 : 0o600,
    });
    if (kind === "unsafe") chmodSync(join(path, name), 0o644);
    if (kind === "multiple")
      writeFileSync(join(path, `.owner-${randomUUID()}`), "", { mode: 0o600 });
    const original = lstatSync(path);
    const names = readdirSync(path).sort();
    const stale = new Date(Date.now() - 60_000);
    utimesSync(path, stale, stale);
    if (kind === "current") {
      const lease = acquireProjectControllerLock(control);
      cleanups.push(() => lease.release());
      lease.assertHeld();
      expect(lstatSync(path).mode & 0o777).toBe(0o700);
      expect(readdirSync(path)).not.toContain(name);
      lease.release();
      expect(existsSync(path)).toBe(false);
    } else {
      expect(() => acquireProjectControllerLock(control)).toThrow();
      expect(lstatSync(path).ino).toBe(original.ino);
      expect(readdirSync(path).sort()).toEqual(names);
    }
  }
});

test("native Node release and stale reclaim preserve an established replacement owner at the actual rmdir cut", async () => {
  const { root } = directory();
  const entry = join(root, "actual-lock.mjs");
  const built = spawnSyncOwned(
    process.execPath,
    [
      "build",
      fileURLToPath(new URL("./lock.ts", import.meta.url)),
      "--target=node",
      "--packages=external",
      "--outfile",
      entry,
    ],
    { env: process.env, encoding: "utf8", timeout: 15_000 },
  );
  expect(built.status).toBe(0);
  const workspace = fileURLToPath(new URL("../../../../", import.meta.url));
  symlinkSync(join(workspace, "node_modules"), join(root, "node_modules"), "junction");
  const child = spawnOwned(
    "node",
    [
      fileURLToPath(new URL("./__fixtures__/controller-lock-rmdir-cut.mjs", import.meta.url)),
      entry,
    ],
    { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (part) => (stdout += part));
  child.stderr.on("data", (part) => (stderr += part));
  const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
  let result;
  try {
    result = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => done({ code, signal }));
    });
  } finally {
    clearTimeout(timer);
  }
  expect(result, stderr).toEqual({ code: 0, signal: null });
  const receipt = JSON.parse(stdout);
  console.info(`Native controller syscall cuts: ${JSON.stringify(receipt)}`);
  expect(receipt.results).toHaveLength(2);
  for (const cut of receipt.results) {
    expect(cut.cutReached).toBe(true);
    expect(cut.preserved).toBe(true);
    expect(cut.markerPreserved).toBe(true);
    expect(cut.independentlyClosed).toBe(true);
    expect(cut.ownedChildExited).toBe(true);
  }
  expect(receipt.results[0].healthyHeartbeat).toBe(true);
}, 40_000);

test("a missing sibling lock permanently invalidates ownership and does not resume heartbeat on restoration", async () => {
  const { control } = directory();
  const lock = acquireProjectControllerLock(control);
  cleanups.push(() => lock.release());
  const path = control + ".lock";
  const original = lstatSync(path);
  renameSync(path, path + ".away");
  expect(() => lock.assertHeld()).toThrow();
  renameSync(path + ".away", path);
  expect(() => lock.assertHeld()).toThrow();
  await new Promise((resolve) => setTimeout(resolve, 10_250));
  expect(lstatSync(path).mtimeMs).toBe(original.mtimeMs);
  expect(() => lock.assertHeld()).toThrow();
}, 15_000);

test("a second actual process keeps its replacement lease when the retired controller closes", async () => {
  const { control } = directory();
  const first = acquireProjectControllerLock(control);
  cleanups.push(() => first.release());
  renameSync(control + ".lock", control + ".lock.original");
  const second = await ownedController(control);
  const replacement = lstatSync(control + ".lock");
  first.release();
  first.release();
  expect(() => first.assertHeld()).toThrow();
  expect(lstatSync(control + ".lock").ino).toBe(replacement.ino);
  await second.check();
  await second.close();
  expect(existsSync(control + ".lock")).toBe(false);
});

test("a retired same-process lease cannot compromise its new owner's heartbeat or release", async () => {
  const { control } = directory();
  const first = acquireProjectControllerLock(control);
  cleanups.push(() => first.release());
  renameSync(control + ".lock", control + ".lock.retired");
  expect(() => first.assertHeld()).toThrow();
  const second = acquireProjectControllerLock(control);
  cleanups.push(() => second.release());
  const before = lstatSync(control + ".lock").mtimeMs;
  first.release();
  await new Promise((resolve) => setTimeout(resolve, 10_250));
  second.assertHeld();
  expect(lstatSync(control + ".lock").mtimeMs).toBeGreaterThan(before);
  second.release();
  expect(existsSync(control + ".lock")).toBe(false);
}, 15_000);

test("the real heartbeat detects a same-mtime sibling replacement before renewing or releasing it", async () => {
  const { control } = directory();
  const first = acquireProjectControllerLock(control);
  cleanups.push(() => first.release());
  const replacement = replaceLock(control);
  await new Promise((resolve) => setTimeout(resolve, 10_250));
  expect(lstatSync(control + ".lock").mtimeMs).toBe(replacement.mtimeMs);
  expect(() => first.assertHeld()).toThrow();
  first.release();
  expect(lstatSync(control + ".lock").ino).toBe(replacement.ino);
}, 15_000);

test("adoption failure closes its lease without releasing a replacement and preserves the pending transaction", async () => {
  const { root, control } = directory();
  // An uninitialized pre-existing control directory is correctly refused.
  rmSync(control, { recursive: true });
  const registry = new ProjectRegistry(root);
  const project = registry.create("legacy.operator", "Synthetic retained project");
  const installationId = registry.installationId;
  registry.close();
  const auth = new HubAuthStore({ dataDir: root });
  await auth.setup({
    token: auth.initialize()!,
    username: "legacy.operator",
    password: "synthetic fixture password",
  });
  const evidenceParent = realpathSync(mkdtempSync(join(process.env.HOME!, "controller-evidence-")));
  cleanups.push(() => rmSync(evidenceParent, { recursive: true, force: true }));
  let replaced = false;
  expect(() =>
    adoptCloudAccount({
      dataDir: root,
      evidenceDirectory: join(evidenceParent, "evidence"),
      installationId,
      ownerId: project.ownerId,
      legacyUsername: "legacy.operator",
      accountOrigin: "https://account.fixture.invalid",
      accountId: randomUUID(),
      io: {
        fsync(fd) {
          if (!replaced && existsSync(join(control, CLOUD_ADOPTION_PENDING))) {
            replaceLock(control);
            replaced = true;
          }
          fsyncSync(fd);
        },
      },
    }),
  ).toThrow();
  expect(replaced).toBe(true);
  expect(existsSync(control + ".lock")).toBe(true);
  expect(JSON.parse(readFileSync(join(control, "registry.json"), "utf8")).version).toBe(1);
  expect(existsSync(join(control, CLOUD_ADOPTION_PENDING))).toBe(true);
});

test("backup validation failure releases its actual lock so another controller can acquire it", async () => {
  const { root, control } = directory();
  rmSync(control, { recursive: true });
  const registry = new ProjectRegistry(root);
  const project = registry.create("owner", "Running synthetic project");
  registry.update(project.id, { status: "running", generation: 1 });
  registry.close();
  await expect(
    backupProjectInstallation({
      dataDir: root,
      destination: join(process.env.HOME!, "unused-backup"),
      helperImage: `sha256:${"a".repeat(64)}`,
    }),
  ).rejects.toThrow("Stop all projects");
  const next = new ProjectRegistry(root);
  next.close();
  expect(existsSync(control + ".lock")).toBe(false);
});

test("controller shutdown still closes its provider and listener after lease loss without deleting a new owner's lock", async () => {
  const { root, control } = directory();
  rmSync(control, { recursive: true });
  writeFileSync(join(root, "index.html"), "<title>Controller fixture</title>");
  let providerClosed = false;
  const server = await startProjectControlServer({
    dataDir: root,
    staticRootDir: root,
    host: "127.0.0.1",
    port: 0,
    provider: {
      availability: async () => ({ available: true }),
      ensure: async () => {
        throw new Error("Fixture cannot launch a runtime.");
      },
      status: async () => ({ state: "stopped" }),
      stop: async () => {},
      close: async () => {
        providerClosed = true;
      },
    },
  });
  cleanups.push(() => server.close().catch(() => {}));
  confinement.allow(server.url);
  renameSync(control + ".lock", control + ".lock.original");
  const second = await ownedController(control);
  await expect(server.close()).rejects.toThrow();
  expect(providerClosed).toBe(true);
  await expect(fetch(server.url + "/health")).rejects.toThrow();
  await second.check();
  await second.close();
  expect(existsSync(control + ".lock")).toBe(false);
});
