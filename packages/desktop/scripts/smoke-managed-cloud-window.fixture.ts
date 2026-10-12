import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import childProcess from "node:child_process";
import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { app, BrowserWindow, session } from "electron";

async function main() {
  const directory = process.env.CODESHELL_MANAGED_WINDOW_ROOT!;
  const origin = process.env.CODESHELL_MANAGED_WINDOW_ORIGIN!;
  assert.equal(new URL(origin).hostname, "127.0.0.1");
  assert.equal(new URL(origin).protocol, "https:");
  assert.ok(process.env.CODE_SHELL_TEST_HOME?.startsWith(`${process.env.HOME}/`));
  const deny = () => {
    throw new Error("Managed window fixture denies Node network and child processes");
  };
  globalThis.fetch = deny as never;
  http.request = http.get = https.request = https.get = deny as never;
  net.connect = net.createConnection = tls.connect = deny as never;
  net.Socket.prototype.connect = deny as never;
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
    (childProcess as any)[name] = deny;
  syncBuiltinESMExports();
  assert.throws(() => https.request(origin));
  assert.throws(() => net.connect(1, "127.0.0.1"));
  assert.throws(() => childProcess.spawn("sh"));
  const fingerprint = new X509Certificate(readFileSync(join(directory, "cert.pem"))).fingerprint256;
  let blocked = 0;
  function confine(current: Electron.Session) {
    current.webRequest.onBeforeRequest((details, callback) => {
      const allowed = new URL(details.url).origin === origin;
      if (!allowed) blocked++;
      callback({ cancel: !allowed });
    });
    current.setCertificateVerifyProc((request, callback) => {
      callback(
        request.hostname === "127.0.0.1" &&
          new X509Certificate(request.certificate.data).fingerprint256 === fingerprint
          ? 0
          : -2,
      );
    });
  }
  app.setPath("userData", join(process.env.HOME!, "electron"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("disable-component-update");
  app.disableHardwareAcceleration();
  app.on("session-created", confine);
  app.on("window-all-closed", () => {});
  await app.whenReady();
  confine(session.defaultSession);
  const { openManagedCloudWorkbench, closeManagedCloudWorkbench } =
    await import("../src/main/cloud-workbench-window.js");
  const { managedCloudPartition } = await import("../src/main/cloud-management-contract.js");
  const projectId = randomUUID();
  const makeGrant = () => ({
    token: randomBytes(32).toString("base64url"),
    session: {
      id: randomUUID(),
      kind: "cloud-management" as const,
      audience: origin,
      installationId: randomUUID(),
      accountOrigin: "https://account.fixture.invalid",
      accountId: randomUUID(),
      managementEpoch: randomUUID(),
      expiresAt: Date.now() + 60_000,
    },
  });
  const first = makeGrant(),
    second = makeGrant(),
    renewed = {
      ...first,
      token: randomBytes(32).toString("base64url"),
      session: { ...first.session, id: randomUUID() },
    };
  const grants = [first, second, renewed];
  const pids = new Set<number>([process.pid]);
  let passed = false;
  try {
    await assert.rejects(session.defaultSession.fetch("https://external.fixture.invalid/"));
    assert.ok(blocked > 0);
    await session.defaultSession.cookies.set({
      url: origin,
      name: "local-marker",
      value: "preserved",
    });
    for (const grant of grants) confine(session.fromPartition(managedCloudPartition(grant)));
    await openManagedCloudWorkbench({ grant: first, projectId, authorized: () => true });
    const win = BrowserWindow.getAllWindows()[0];
    win.hide();
    const partition = managedCloudPartition(first);
    const cookies = await session
      .fromPartition(partition)
      .cookies.get({ name: "cs_cloud_management" });
    assert.equal(cookies.length, 1);
    assert.equal(cookies[0].value, first.token);
    assert.equal(cookies[0].httpOnly, true);
    assert.equal(cookies[0].secure, true);
    assert.equal(cookies[0].sameSite, "strict");
    assert.ok(cookies[0].expirationDate! <= first.session.expiresAt / 1000);
    assert.deepEqual(
      await win.webContents.executeJavaScript(
        "({bridge:typeof window.codeshell,require:typeof require,process:typeof process,cookie:document.cookie})",
      ),
      { bridge: "undefined", require: "undefined", process: "undefined", cookie: "" },
    );
    // Electron 33 exposes this native inspection method without a declaration.
    const prefs = (
      win.webContents as Electron.WebContents & {
        getLastWebPreferences(): Electron.WebPreferences;
      }
    ).getLastWebPreferences();
    assert.equal(prefs.sandbox, true);
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.webviewTag, false);
    assert.equal(prefs.preload, undefined);
    await openManagedCloudWorkbench({
      grant: first,
      projectId: randomUUID(),
      authorized: () => true,
    });
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    await openManagedCloudWorkbench({ grant: second, projectId, authorized: () => true });
    await openManagedCloudWorkbench({ grant: renewed, projectId, authorized: () => true });
    for (const current of BrowserWindow.getAllWindows()) current.hide();
    assert.equal(BrowserWindow.getAllWindows().length, 3);
    assert.notEqual(managedCloudPartition(first), managedCloudPartition(renewed));
    const closing = closeManagedCloudWorkbench(partition);
    assert.equal(
      win.isDestroyed(),
      true,
      "owned window closes before asynchronous cookie deletion",
    );
    await closing;
    assert.equal((await session.fromPartition(partition).cookies.get({})).length, 0);
    for (const grant of [second, renewed])
      assert.equal(
        (
          await session
            .fromPartition(managedCloudPartition(grant))
            .cookies.get({ name: "cs_cloud_management" })
        )[0].value,
        grant.token,
      );
    assert.equal(
      (await session.defaultSession.cookies.get({ name: "local-marker" }))[0].value,
      "preserved",
    );
    assert.equal(
      (await session.defaultSession.cookies.get({ name: "cs_cloud_management" })).length,
      0,
    );
    const before = BrowserWindow.getAllWindows().length;
    await assert.rejects(
      openManagedCloudWorkbench({
        grant: { ...first, session: { ...first.session, expiresAt: Date.now() - 1 } },
        projectId,
        authorized: () => true,
      }),
    );
    assert.equal(BrowserWindow.getAllWindows().length, before);
    const late = makeGrant();
    confine(session.fromPartition(managedCloudPartition(late)));
    let authorized = true;
    app.once("browser-window-created", (_event, created) => {
      created.webContents.once("did-finish-load", () => {
        authorized = false;
      });
    });
    await assert.rejects(
      openManagedCloudWorkbench({ grant: late, projectId, authorized: () => authorized }),
    );
    assert.equal(
      (await session.fromPartition(managedCloudPartition(late)).cookies.get({})).length,
      0,
    );
    assert.equal(BrowserWindow.getAllWindows().length, before);
    passed = true;
  } finally {
    for (const metric of app.getAppMetrics()) pids.add(metric.pid);
    for (const grant of grants) await closeManagedCloudWorkbench(managedCloudPartition(grant));
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    await writeFile(
      join(directory, "receipt.json"),
      JSON.stringify({
        passed,
        windows: BrowserWindow.getAllWindows().length,
        pids: [...pids],
        blocked,
      }),
    );
    app.exit(passed ? 0 : 1);
  }
}
void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
