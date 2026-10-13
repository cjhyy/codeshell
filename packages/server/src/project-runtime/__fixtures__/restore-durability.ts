import assert from "node:assert/strict";
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readFile, rm } from "node:fs/promises";
import { installCloudControlConfinement } from "./cloud-control-confinement.js";

const [scenario, directory] = process.argv.slice(2);
const root = fs.realpathSync(directory);
const rawExecFile = childProcess.execFile;
const rawFsync = fs.fsyncSync;
const rawLstat = fs.lstatSync;
const confinement = installCloudControlConfinement();
const image = `sha256:${"a".repeat(64)}`;
const cli = join(root, "docker");
const cliBytes = Buffer.from(`#!${process.execPath}
// Owned fake Docker: only inventories and local immutable image inspection.
import assert from 'node:assert/strict';
const args = process.argv.slice(2);
assert.equal(process.env.HOME, ${JSON.stringify(process.env.HOME)});
assert.ok(${JSON.stringify([
  ["image", "inspect", image],
  ["ps", "-a", "--format", "{{.Names}}"],
  ["volume", "ls", "--format", "{{.Name}}"],
])}.some(expected => JSON.stringify(expected) === JSON.stringify(args)));
process.stdout.write(args[0] === 'image' ? '[]' : '');
`);
fs.writeFileSync(cli, cliBytes, { flag: "wx", mode: 0o700 });
const cliHash = createHash("sha256").update(cliBytes).digest("hex");
const cliPin = fs.lstatSync(cli);
const children = new Set<childProcess.ChildProcess>();
let commands = 0;
// The only process exception is this exact owned inode/content and fixed argv.
childProcess.execFile = ((command, args, options, callback) => {
  assert.equal(command, "docker");
  assert.equal(fs.realpathSync(cli), cli);
  const current = fs.lstatSync(cli);
  assert.equal(current.isFile(), true);
  assert.equal(current.dev, cliPin.dev);
  assert.equal(current.ino, cliPin.ino);
  assert.equal(current.nlink, 1);
  assert.equal(createHash("sha256").update(fs.readFileSync(cli)).digest("hex"), cliHash);
  assert.ok(
    [
      ["image", "inspect", image],
      ["ps", "-a", "--format", "{{.Names}}"],
      ["volume", "ls", "--format", "{{.Name}}"],
    ].some((expected) => JSON.stringify(expected) === JSON.stringify(args)),
  );
  assert.equal(options.encoding, "utf8");
  assert.equal(options.timeout, 30_000);
  assert.equal(options.maxBuffer, 4 * 1024 * 1024);
  commands++;
  const child = rawExecFile(
    cli,
    args,
    {
      ...options,
      cwd: root,
      env: { HOME: process.env.HOME, USERPROFILE: process.env.HOME },
    },
    (...values) => {
      const after = fs.lstatSync(cli);
      assert.equal(after.dev, cliPin.dev);
      assert.equal(after.ino, cliPin.ino);
      assert.equal(after.nlink, 1);
      callback(...values);
    },
  );
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
}) as typeof childProcess.execFile;
syncBuiltinESMExports();

// No Server/Core import occurs until HOME, network and process guards are active.
const adapterUrl = new URL("./restore-durability-adapters.mjs", import.meta.url).href;
const currentBackup = await import(adapterUrl);
const currentControl = currentBackup;
const { HubAuthStore, ProjectRegistry } = currentBackup;
const provider = {
  availability: async () => ({ available: true }),
  ensure: async () => {
    throw new Error("Unstarted restore fixture cannot create a runtime");
  },
  status: async () => ({ state: "stopped" as const }),
  stop: async () => {},
  close: async () => {},
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function waitChildren() {
  for (let i = 0; i < 500 && children.size; i++) await sleep(10);
  assert.equal(children.size, 0);
}
async function source() {
  const dataDir = join(root, "original");
  const registry = new ProjectRegistry(dataDir);
  const project = registry.create("restore.operator", "Unstarted retained project");
  const installationId = registry.installationId;
  registry.close();
  const auth = new HubAuthStore({ dataDir });
  const login = { username: "restore.operator", password: "synthetic restore password" };
  const grant = await auth.setup({ ...login, token: auth.initialize()! });
  fs.writeFileSync(
    join(dataDir, "environment.json"),
    JSON.stringify({ obsolete: "synthetic snapshot identity" }),
  );
  const backup = join(root, "backup");
  await currentBackup.backupProjectInstallation({
    dataDir,
    destination: backup,
    helperImage: image,
  });
  return { dataDir, backup, login, grant, project, installationId };
}
function fdPath(fd: number, destination: string) {
  const opened = fs.fstatSync(fd);
  for (const [label, path] of [
    ["marker", join(destination, "restore-in-progress")],
    ["root", destination],
    ["parent", root],
    ["auth", join(destination, "hub/auth.json")],
    ["hub", join(destination, "hub")],
    ["control", join(destination, "project-control")],
  ]) {
    const candidate = rawLstat(path, { throwIfNoEntry: false });
    if (candidate?.ino === opened.ino && candidate.dev === opened.dev) return label;
  }
  return "registry-temp";
}
async function blocked(destination: string) {
  assert.ok(rawLstat(join(destination, "restore-in-progress"), { throwIfNoEntry: false }));
  await assert.rejects(
    currentControl.startProjectControlServer({
      dataDir: destination,
      host: "127.0.0.1",
      port: 0,
      provider,
    }),
    /restore is incomplete/,
  );
}
type Restore = (...args: any[]) => Promise<any>;
async function restoreWithMonitor(
  restore: Restore,
  backup: string,
  destination: string,
  cut = 0,
  removeFault: false | "before" | "after" = false,
  recoveryCut = 0,
) {
  const events: string[] = [];
  let calls = 0,
    failed = false,
    recovery = 0;
  const flush = (fd: number) => {
    const path = fdPath(fd, destination);
    events.push(path);
    if ((!failed && ++calls === cut) || (failed && recoveryCut && ++recovery === recoveryCut)) {
      failed = true;
      throw new Error("injected actual fsync failure");
    }
    if (path === "auth") assert.equal(JSON.parse(fs.readFileSync(fd, "utf8")).sessions.length, 0);
    rawFsync(fd);
  };
  // Both the real historical algorithm and current implementation observe the
  // same native fsync monitor; historical restore does not know the new io seam.
  fs.fsyncSync = flush;
  syncBuiltinESMExports();
  try {
    const result = await restore({
      source: backup,
      destination,
      helperImage: image,
      io: {
        fsync: flush,
        removeMarker: async (path) => {
          assert.ok(events.includes("auth"), "revoked auth must be flushed before publication");
          assert.ok(
            events.includes("hub"),
            "auth rename directory must be flushed before publication",
          );
          if (removeFault === "before") {
            failed = true;
            throw new Error("injected actual marker removal failure");
          }
          await rm(path);
          if (removeFault === "after") {
            failed = true;
            throw new Error("injected actual marker removal failure");
          }
        },
      },
    });
    return { result, events, calls, recovery };
  } finally {
    fs.fsyncSync = rawFsync;
    syncBuiltinESMExports();
  }
}
async function coldSessionCheck(destination: string, fixture: Awaited<ReturnType<typeof source>>) {
  const controller = await currentControl.startProjectControlServer({
    dataDir: destination,
    host: "127.0.0.1",
    port: 0,
    provider,
  });
  confinement.allow(controller.url);
  try {
    const old = await fetch(controller.url + "/api/v1/projects", {
      headers: { Cookie: `cs_hub_session=${fixture.grant.token}`, Origin: controller.url },
    });
    await old.arrayBuffer();
    assert.equal(old.status, 401);
    const fresh = await fetch(controller.url + "/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: controller.url },
      body: JSON.stringify(fixture.login),
    });
    assert.equal(fresh.status, 200);
    await fresh.arrayBuffer();
    const cookie = fresh.headers.get("set-cookie")!.split(";", 1)[0];
    const list = await fetch(controller.url + "/api/v1/projects", {
      headers: { Cookie: cookie, Origin: controller.url },
    });
    assert.equal(list.status, 200);
    assert.equal((await list.json()).projects[0].id, fixture.project.id);
  } finally {
    await controller.close();
  }
}
async function historical(name: string) {
  const file = new URL(`./restore-durability-${name}-v1.txt`, import.meta.url);
  const bytes = await readFile(file, "utf8");
  const expected =
    name === "backup"
      ? "08d365f915468d7c2109fe7f484d214c8b88f280d1dfe5db0cad713faea65186"
      : "55b36c2f03ad310eb7915924970824f7d8fe4fd70f84f6e107991f927bf70984";
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expected);
  return import(new URL(`./historical-${name}.mjs`, import.meta.url).href);
}
let receipt: Record<string, unknown>;
let injectedFailure = false;
function assertPublishedDurability(events: string[]) {
  assert.ok(events.includes("auth"), "Revoked auth file must be flushed before publication");
  assert.ok(events.indexOf("auth") > events.indexOf("marker"));
  assert.ok(events.indexOf("hub") > events.indexOf("auth"));
  assert.ok(events.indexOf("registry-temp") > events.indexOf("hub"));
  assert.equal(events.at(-1), "root");
}
try {
  if (scenario === "durability") {
    const f = await source();
    const preserved = [
      join(f.dataDir, "hub/auth.json"),
      join(f.backup, "manifest.json"),
      join(f.backup, "control/hub/auth.json"),
    ].map((path) => ({ path, bytes: fs.readFileSync(path) }));
    const successful = join(root, "success");
    const baseline = await restoreWithMonitor(
      currentBackup.restoreProjectInstallation,
      f.backup,
      successful,
    );
    assertPublishedDurability(baseline.events);
    assert.ok(baseline.calls >= 11);
    assert.equal(
      rawLstat(join(successful, "restore-in-progress"), { throwIfNoEntry: false }),
      undefined,
    );
    assert.notEqual(baseline.result.installationId, f.installationId);
    assert.equal(fs.existsSync(join(successful, "environment.json")), false);
    await coldSessionCheck(successful, f);
    for (let cut = 1; cut <= baseline.calls; cut++) {
      const destination = join(root, `cut-${cut}`);
      await assert.rejects(
        restoreWithMonitor(currentBackup.restoreProjectInstallation, f.backup, destination, cut),
        /injected actual fsync failure/,
      );
      await blocked(destination);
      // Even if the pre-revoke auth bytes survived a crash, the durable barrier
      // prevents the real legacy controller from exposing their old sessions.
      if (rawLstat(join(destination, "hub"), { throwIfNoEntry: false }))
        fs.writeFileSync(
          join(destination, "hub/auth.json"),
          fs.readFileSync(join(f.backup, "control/hub/auth.json")),
        );
      await blocked(destination);
    }
    for (const when of ["before", "after"] as const) {
      const removed = join(root, `remove-fault-${when}`);
      await assert.rejects(
        restoreWithMonitor(currentBackup.restoreProjectInstallation, f.backup, removed, 0, when),
        /injected actual marker removal failure/,
      );
      await blocked(removed);
    }
    for (let cut = 1; cut <= 3; cut++) {
      const destination = join(root, `rearm-cut-${cut}`);
      await assert.rejects(
        restoreWithMonitor(
          currentBackup.restoreProjectInstallation,
          f.backup,
          destination,
          baseline.calls,
          false,
          cut,
        ),
        /durable barrier could not be confirmed/,
      );
      await blocked(destination);
    }
    for (const { path, bytes } of preserved) assert.deepEqual(fs.readFileSync(path), bytes);
    receipt = {
      scenario,
      passed: true,
      fsyncCuts: baseline.calls,
      markerRemovalCuts: 2,
      rearmFsyncCuts: 3,
      successEvents: baseline.events,
      oldSession401AfterColdStart: true,
      originalAndBackupUnchanged: true,
      legacyEnvironmentFileRemoved: true,
    };
  } else if (scenario === "barriers") {
    const cases = ["file", "directory", "dangling", "EIO", "EACCES", "ENOTDIR"];
    for (const kind of cases) {
      const destination = join(root, `barrier-${kind}`);
      fs.mkdirSync(destination);
      const marker = join(destination, "restore-in-progress");
      if (kind === "file") fs.writeFileSync(marker, "1\n");
      if (kind === "directory") fs.mkdirSync(marker);
      if (kind === "dangling") fs.symlinkSync(join(root, "absent"), marker);
      fs.lstatSync = ((path, options) => {
        if (path === marker && kind.startsWith("E"))
          throw Object.assign(new Error(kind), { code: kind });
        return rawLstat(path, options as any);
      }) as typeof fs.lstatSync;
      syncBuiltinESMExports();
      try {
        await assert.rejects(
          currentControl.startProjectControlServer({
            dataDir: destination,
            host: "127.0.0.1",
            port: 0,
            provider,
          }),
          kind.startsWith("E") ? new RegExp(kind) : /restore is incomplete/,
        );
        assert.deepEqual(
          fs.readdirSync(destination),
          kind.startsWith("E") ? [] : ["restore-in-progress"],
        );
      } finally {
        fs.lstatSync = rawLstat;
        syncBuiltinESMExports();
      }
    }
    const parentFile = join(root, "barrier-real-parent-file");
    fs.writeFileSync(parentFile, "unchanged parent file");
    await assert.rejects(
      currentControl.startProjectControlServer({
        dataDir: parentFile,
        host: "127.0.0.1",
        port: 0,
        provider,
      }),
      (error: NodeJS.ErrnoException) => error.code === "ENOTDIR",
    );
    assert.equal(fs.readFileSync(parentFile, "utf8"), "unchanged parent file");
    receipt = {
      scenario,
      passed: true,
      barrierCases: [...cases, "real-parent-file-ENOTDIR"],
      noRegistryOrHubSideEffects: true,
    };
  } else if (scenario === "cleanup-failure") {
    const f = await source();
    await restoreWithMonitor(
      currentBackup.restoreProjectInstallation,
      f.backup,
      join(root, "before-injected-failure"),
    );
    throw new Error("Expected post-restore fixture failure");
  } else {
    assert.equal(scenario, "legacy");
    const f = await source();
    const oldBackup = await historical("backup");
    const oldControl = await historical("control");
    const restored = await restoreWithMonitor(
      oldBackup.restoreProjectInstallation,
      f.backup,
      join(root, "historical-restore"),
    );
    assert.throws(
      () => assertPublishedDurability(restored.events),
      /Revoked auth file must be flushed/,
    );
    assert.equal(
      restored.events.includes("auth"),
      false,
      "historical restore lacks the revoked auth file flush",
    );
    assert.equal(
      restored.events.includes("hub"),
      false,
      "historical restore lacks the auth rename directory flush",
    );
    assert.equal(
      restored.events.includes("root"),
      false,
      "historical restore lacks root publication flush",
    );
    const destination = join(root, "historical-dangling");
    fs.mkdirSync(destination);
    fs.symlinkSync(join(root, "absent"), join(destination, "restore-in-progress"));
    const controller = await oldControl.startProjectControlServer({
      dataDir: destination,
      host: "127.0.0.1",
      port: 0,
      provider,
    });
    await controller.close();
    assert.ok(
      fs.existsSync(join(destination, "project-control/registry.json")),
      "historical controller incorrectly initialized behind a dangling marker",
    );
    receipt = {
      scenario,
      passed: true,
      historicalAuthFlushMissing: true,
      historicalHubDirectoryFlushMissing: true,
      historicalPublicationFlushMissing: true,
      historicalDanglingBarrierBypassed: true,
      samePublicationContractRejected: true,
    };
  }
} catch (error) {
  if (
    scenario !== "cleanup-failure" ||
    !(error instanceof Error) ||
    error.message !== "Expected post-restore fixture failure"
  )
    throw error;
  injectedFailure = true;
  receipt = { scenario, passed: true, actualPostRestoreFailure: true };
} finally {
  fs.fsyncSync = rawFsync;
  fs.lstatSync = rawLstat;
  syncBuiltinESMExports();
  await waitChildren();
  confinement.restore();
}
console.log(
  JSON.stringify({
    ...receipt,
    runtime: process.version,
    ownedDockerChildrenExited: true,
    guardedDockerCommands: commands,
  }),
);
if (injectedFailure) process.exitCode = 1;
