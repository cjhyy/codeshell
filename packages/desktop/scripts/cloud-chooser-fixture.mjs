import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { readFileSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { request } from "node:https";
import { createBunTestEnvironment } from "../../../scripts/bun-test-completion.mjs";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export const bounded = async (promise, label, ms = 30_000) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, fail) => {
        timer = setTimeout(() => fail(new Error(`${label} deadline; fixture HOME preserved`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const exited = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ");
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
};
const lines = async (file) =>
  (
    await readFile(file, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    })
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

export async function prepareCloudChooserFixture(
  appDir,
  isolated,
  { failAfterReady = false } = {},
) {
  const env = createBunTestEnvironment(process.env, isolated.home);
  const home = env.HOME;
  env.CODESHELL_CLOUD_CHOOSER_HOME = home;
  isolated.home = home;
  isolated.codeShellHome = env.CODE_SHELL_HOME;
  isolated.userDataDir = join(home, "electron-user-data");
  await writeFile(join(env.CODE_SHELL_HOME, "settings.json"), '{"autoUpdates":false}\n', {
    mode: 0o600,
  });
  for (const name of ["account", "cloud"])
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        `/CN=chooser-${name}`,
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        join(home, `${name}.key`),
        "-out",
        join(home, `${name}.pem`),
      ],
      { env, stdio: "ignore" },
    );
  const ca = Buffer.concat([
    await readFile(join(home, "account.pem")),
    await readFile(join(home, "cloud.pem")),
  ]);
  await writeFile(join(home, "ca.pem"), ca, { mode: 0o600 });
  execFileSync(
    "bun",
    [
      "build",
      "scripts/cloud-chooser-server.ts",
      "--outdir",
      join(home, "fixture-build"),
      "--target=node",
      "--splitting",
      "--external=@cjhyy/code-shell-core",
      "--external=@cjhyy/code-shell-core/*",
      "--external=ws",
    ],
    { cwd: appDir, env, stdio: "pipe" },
  );
  await writeFile(join(home, "fixture-build/package.json"), '{"type":"module"}');
  await symlink(join(appDir, "node_modules"), join(home, "fixture-build/node_modules"));
  const child = spawn(process.execPath, [join(home, "fixture-build/cloud-chooser-server.js")], {
    env,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const closed = new Promise((done, fail) => {
    child.once("error", fail);
    child.once("close", (code, signal) => done({ code, signal }));
  });
  try {
    const ready = await bounded(
      Promise.race([
        once(child, "message").then(([value]) => value),
        closed.then((result) => {
          throw new Error(`Cloud fixture closed before ready: ${JSON.stringify(result)}`);
        }),
      ]),
      "Cloud fixture startup",
    );
    assert.equal(ready.ready, true);
    if (failAfterReady)
      throw new Error("Injected fixture preparation failure after actual Server ready");
    const guardUrl = new URL("./cloud-chooser-guard.mjs", import.meta.url).href;
    const workerPreload = join(home, "chooser-worker.mjs"),
      mainEntry = join(home, "chooser-main.mjs");
    const origins = [ready.accountOrigin, ready.cloudOrigin];
    await writeFile(
      workerPreload,
      `import { installChooserGuard } from ${JSON.stringify(guardUrl)};\ninstallChooserGuard({ origins: ${JSON.stringify(origins)}, role: "worker" });\n`,
      { mode: 0o600 },
    );
    const fingerprint = new X509Certificate(await readFile(join(home, "cloud.pem"))).fingerprint256
      .replaceAll(":", "")
      .toLowerCase();
    const workerEntry = createRequire(join(appDir, "package.json")).resolve(
      "@cjhyy/code-shell-core/bin/agent-server-stdio",
    );
    await writeFile(
      mainEntry,
      `import { app, net, session } from "electron";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { installChooserGuard } from ${JSON.stringify(guardUrl)};
installChooserGuard({ origins: ${JSON.stringify(origins)}, workerPreload: ${JSON.stringify(pathToFileURL(workerPreload).href)}, workerEntry: ${JSON.stringify(workerEntry)}, role: "main" });
app.setAppPath(${JSON.stringify(appDir)});
globalThis.chooserBlockedRequests = 0;
const sessions = new Set();
const configure = (session) => {
  if (sessions.has(session)) return;
  sessions.add(session);
  session.setCertificateVerifyProc((request, callback) => callback(
    request.hostname === "127.0.0.1" && (request.certificate.fingerprint256 ?? request.certificate.fingerprint).replaceAll(":", "").toLowerCase() === ${JSON.stringify(fingerprint)} ? 0 : -3));
  session.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    const local = ["file:", "data:", "blob:", "about:", "devtools:", "codeshell-resource:", "codeshell-attachment:"].includes(url.protocol);
    const allowed = local || url.origin === ${JSON.stringify(ready.cloudOrigin)};
    if (!allowed) globalThis.chooserBlockedRequests++;
    callback({ cancel: !allowed });
  });
};
app.on("web-contents-created", (_event, contents) => configure(contents.session));
for (const method of ["request", "fetch"]) {
  const original = net[method].bind(net);
  net[method] = (input, ...args) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== ${JSON.stringify(ready.cloudOrigin)}) throw new Error("Cloud chooser refused Electron native network");
    return original(input, ...args);
  };
  assert.throws(() => net[method]("https://external.invalid/"), /refused Electron native network/);
}
const chromiumGuardReady = app.whenReady().then(async () => {
configure(session.defaultSession);
await assert.rejects(session.defaultSession.fetch("https://external.invalid/chooser-guard-probe"));
assert.equal(globalThis.chooserBlockedRequests, 1);
appendFileSync(${JSON.stringify(join(home, "chooser-native-guards.jsonl"))}, JSON.stringify({ pid: process.pid, nativeNegativeProbes: 2, chromiumNegativeProbes: 1 }) + "\\n", { mode: 0o600 });
});
// Main registers privileged schemes before ready. Node/native guards and the
// earlier ready/session hooks already confine every product window/request.
await Promise.all([
  chromiumGuardReady,
  import(${JSON.stringify(pathToFileURL(join(appDir, "out/main/index.mjs")).href)}),
]);
`,
      { mode: 0o600 },
    );
    execFileSync(process.execPath, ["--check", mainEntry], { env, stdio: "pipe" });
    execFileSync(process.execPath, ["--check", workerPreload], { env, stdio: "pipe" });
    const removed = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]));
    const electronEnv = {
      ...removed,
      ...env,
      CODE_SHELL_TEST_HOME: isolated.codeShellHome,
      NODE_EXTRA_CA_CERTS: join(home, "ca.pem"),
    };
    let serverClosed = false;
    return {
      ...ready,
      child,
      mainEntry,
      electronEnv,
      async keyring() {
        assert.equal(
          process.platform,
          "linux",
          "Native chooser gate requires the owned Linux SecretService; do not retry macOS Keychain",
        );
        const control = process.env.GNOME_KEYRING_CONTROL,
          bus = process.env.DBUS_SESSION_BUS_ADDRESS;
        assert.ok(control && bus && process.env.XDG_CURRENT_DESKTOP === "GNOME");
        const root = dirname(dirname(control));
        const stat = lstatSync(root);
        assert.equal(
          stat.isDirectory() &&
            !stat.isSymbolicLink() &&
            stat.uid === process.getuid() &&
            !(stat.mode & 0o077),
          true,
        );
        assert.equal(await realpath(root), root);
        const reply = execFileSync(
          "dbus-send",
          [
            "--session",
            "--reply-timeout=1500",
            "--type=method_call",
            "--print-reply",
            "--dest=org.freedesktop.DBus",
            "/",
            "org.freedesktop.DBus.GetConnectionUnixProcessID",
            "string:org.freedesktop.secrets",
          ],
          { encoding: "utf8", env: process.env, timeout: 2000 },
        );
        const pid = Number(reply.match(/uint32\s+(\d+)/)?.[1]);
        assert.ok(pid > 0);
        assert.equal(await realpath(`/proc/${pid}/exe`), "/usr/bin/gnome-keyring-daemon");
        const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
        assert.ok(argv.includes("--foreground") && argv.includes(`--control-directory=${control}`));
        for (const key of [
          "DBUS_SESSION_BUS_ADDRESS",
          "DBUS_SESSION_BUS_PID",
          "GNOME_KEYRING_CONTROL",
          "XDG_CURRENT_DESKTOP",
          "XDG_RUNTIME_DIR",
        ])
          if (process.env[key]) electronEnv[key] = process.env[key];
        return { privateDaemonPid: pid, native: true };
      },
      async request(origin, path, { method = "GET", body, token } = {}) {
        assert.ok(origins.includes(origin));
        return await bounded(
          new Promise((done, fail) => {
            const req = request(
              origin + path,
              {
                ca,
                method,
                headers: {
                  ...(origin === ready.accountOrigin ? { Origin: origin } : {}),
                  ...(body ? { "content-type": "application/json" } : {}),
                  ...(token ? { authorization: `Bearer ${token}` } : {}),
                },
              },
              (res) => {
                let text = "";
                res.on("data", (part) => {
                  text += part;
                });
                res.on("error", fail);
                res.on("end", () => done({ status: res.statusCode, body: JSON.parse(text) }));
              },
            );
            const timer = setTimeout(
              () => req.destroy(new Error("Cloud fixture request deadline")),
              15_000,
            );
            req.once("close", () => clearTimeout(timer));
            req.on("error", fail);
            req.end(body ? JSON.stringify(body) : undefined);
          }),
          "Cloud fixture request",
        );
      },
      async assertGuards(app) {
        const guards = await lines(join(home, "chooser-guards.jsonl"));
        const workers = await lines(join(home, "chooser-workers.jsonl"));
        const native = await lines(join(home, "chooser-native-guards.jsonl"));
        assert.ok(guards.some((row) => row.pid === child.pid && row.negativeProbes === 4));
        if (app) {
          assert.ok(
            native.some(
              (row) =>
                row.pid === app.process().pid &&
                row.nativeNegativeProbes === 2 &&
                row.chromiumNegativeProbes === 1,
            ),
          );
          assert.ok(
            guards.some(
              (row) =>
                row.pid === app.process().pid && row.role === "main" && row.negativeProbes === 4,
            ),
          );
          for (const worker of workers)
            assert.ok(
              guards.some(
                (row) =>
                  row.pid === worker.pid &&
                  row.role === "worker" &&
                  guards.some((main) => main.pid === row.ppid && main.role === "main") &&
                  row.negativeProbes === 4,
              ),
            );
        }
        return { guards: guards.length, workers: workers.length };
      },
      async close() {
        if (!serverClosed) {
          child.send({ close: true });
          const result = await bounded(closed, "Cloud fixture close");
          assert.deepEqual(result, { code: 0, signal: null });
          serverClosed = true;
        }
        const receipt = JSON.parse(
          await readFile(join(home, "chooser-server-receipt.json"), "utf8"),
        );
        assert.equal(receipt.passed, true);
        assert.equal(receipt.running, 0);
        assert.equal(receipt.listeners, 0);
        assert.equal(receipt.sockets, 0);
        return receipt;
      },
      async assertElectronExited(app, pids) {
        const child = app.process();
        if (child.exitCode == null && child.signalCode == null)
          await bounded(once(child, "close"), "Electron child close");
        const workers = await lines(join(home, "chooser-workers.jsonl"));
        for (const worker of workers) pids.add(worker.pid);
        pids.add(child.pid);
        for (let attempt = 0; attempt < 100 && [...pids].some((pid) => !exited(pid)); attempt++)
          await sleep(50);
        assert.equal(
          [...pids].some((pid) => !exited(pid)),
          false,
          "Owned Electron/worker processes must exit before HOME cleanup",
        );
        return pids.size;
      },
      sourceHash: createHash("sha256")
        .update(await readFile(join(appDir, "out/main/index.mjs")))
        .digest("hex"),
    };
  } catch (error) {
    if (child.connected) child.send({ close: true });
    try {
      const result = await bounded(closed, "Cloud fixture failed-start shutdown", 15_000);
      await writeFile(
        join(home, "chooser-preparation-failure.json"),
        JSON.stringify({ serverPid: child.pid, ...result }),
        { mode: 0o600 },
      );
    } catch (closeError) {
      throw new AggregateError([error, closeError], `Server exit unknown; preserve ${home}`, {
        cause: closeError,
      });
    }
    throw error;
  }
}
