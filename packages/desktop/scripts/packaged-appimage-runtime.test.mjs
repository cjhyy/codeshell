import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { assertAppImageMainIdentity, assertAppImagePayload } from "./packaged-appimage-runtime.mjs";
import { inventoryAppTree } from "./packaged-app-integrity.mjs";
import { preloadPausedPackagedMain } from "./packaged-main-preload.mjs";
import { snapshotElectronTestProcesses } from "./electron-test-process-snapshot.mjs";
import { watchElectronTestProcess } from "./electron-test-watchdog.mjs";

test("runtime parent and paused Main require separate fresh PID/parent/full-birth and exact paths", () => {
  const root = { pid: 101, ppid: 100, birth: "full-root-birth" };
  const birth = { pid: 102, ppid: 101, birth: "full-main-birth" };
  const expected = {
    executable: "/owned/cache/app",
    appImage: "/owned/app.AppImage",
    appDir: "/owned/cache",
    home: "/owned/home",
  };
  const main = { pid: 102, ppid: 101, ...expected, argv: [expected.executable, "--inspect-brk=0"] };
  const rows = [root, birth];
  assert.equal(assertAppImageMainIdentity(root, main, rows, expected).birth, birth.birth);
  assert.equal(
    assertAppImageMainIdentity(root, { ...main, birth: "untrusted-birth" }, rows, expected).birth,
    birth.birth,
  );
  for (const changed of [
    { pid: root.pid },
    { ppid: 999 },
    { executable: "/foreign/app" },
    { appImage: "/foreign.AppImage" },
    { appDir: "/foreign" },
    { home: "/foreign" },
    { argv: ["--no-sandbox"] },
  ])
    assert.throws(() => assertAppImageMainIdentity(root, { ...main, ...changed }, rows, expected));
  assert.throws(() =>
    assertAppImageMainIdentity(root, main, [{ ...root, birth: "reused" }, birth], expected),
  );
  assert.throws(() =>
    assertAppImageMainIdentity(root, main, [root, { ...birth, ppid: 999 }], expected),
  );
  assert.throws(() => assertAppImageMainIdentity(root, main, [root], expected));
});

test("owned extracted payload must retain every source file byte and link target", async () => {
  const root = await mkdtemp(join(tmpdir(), "appimage-payload-contract-"));
  try {
    const source = join(root, "source"),
      extracted = join(root, "extracted");
    await mkdir(source);
    await writeFile(join(source, "app.asar"), "owned-source");
    await cp(source, extracted, { recursive: true });
    await writeFile(join(extracted, "AppRun"), "owned-runtime");
    const baseline = await inventoryAppTree(source);
    assertAppImagePayload(baseline, await inventoryAppTree(extracted));
    await writeFile(join(extracted, "app.asar"), "changed-data");
    assert.throws(() => assertAppImagePayload(baseline, [["app.asar", "link", "/foreign"]]));
    assert.throws(() => assertAppImagePayload(baseline, []));
    const changed = await inventoryAppTree(extracted);
    assert.throws(() => assertAppImagePayload(baseline, changed));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real owned Node wrapper/paused child keeps launcher and Main identities separate before guard", async () => {
  // Contract test only: native Node inspector and actual fork topology, no
  // AppImage/Electron claim and no APPIMAGE/APPDIR values fabricated in env.
  const node = await realpath(
    execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim(),
  );
  const root = await realpath(await mkdtemp(join(tmpdir(), "appimage-pause-contract-")));
  let monitor, wrapper;
  try {
    const entry = join(root, "entry.mjs"),
      bootstrap = join(root, "guard.cjs"),
      marker = join(root, "entry-result");
    await writeFile(bootstrap, "globalThis.__guardInstalled = true;");
    await writeFile(
      entry,
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)},String(globalThis.__guardInstalled===true));`,
    );
    const script = join(root, "wrapper.cjs");
    await writeFile(
      script,
      `const child=require("node:child_process").spawn(process.execPath,["--inspect-brk=0",${JSON.stringify(entry)}],{stdio:["ignore","inherit","inherit"],env:process.env}); child.on("close",(code,signal)=>{process.exitCode=signal?1:code;});`,
    );
    wrapper = spawn(node, [script], {
      cwd: root,
      env: { HOME: root, PATH: process.env.PATH },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let rootIdentity;
    monitor = watchElectronTestProcess(wrapper, {
      timeoutMs: 10_000,
      snapshotProcesses: () => {
        const rows = snapshotElectronTestProcesses();
        rootIdentity ??= rows.find((row) => row.pid === wrapper.pid && row.ppid === process.pid);
        return rows;
      },
    });
    const receipt = await preloadPausedPackagedMain(wrapper, bootstrap, {
      allowedPause: (url) => url === pathToFileURL(entry).href,
      isHostScript: () => false,
      terminateChild: () => monitor.terminate(),
      launcherOwnsInspector: false,
      verifyPausedIdentity: async (evaluate) => {
        const identity = assertAppImageMainIdentity(
          rootIdentity,
          await evaluate(
            "({pid:process.pid,ppid:process.ppid,executable:require('node:fs').realpathSync(process.execPath),home:process.env.HOME,argv:process.argv})",
          ),
          snapshotElectronTestProcesses(),
          { executable: node, home: root },
        );
        assert.deepEqual(monitor.bindObservedDescendant(identity.pid), {
          pid: identity.pid,
          ppid: identity.ppid,
          birth: identity.birth,
        });
        return identity;
      },
    });
    assert.equal(receipt.launcherPid, wrapper.pid);
    assert.notEqual(receipt.pid, wrapper.pid);
    assert.equal(receipt.mainIdentity.ppid, wrapper.pid);
    const settlement = await monitor.completed;
    assert.equal(settlement.status, "cleaned");
    assert.ok(
      settlement.owned.some(
        (row) => row.pid === receipt.pid && row.birth === receipt.mainIdentity.birth,
      ),
    );
    assert.equal(wrapper.exitCode, 0);
    assert.equal(wrapper.signalCode, null);
    assert.equal(await readFile(marker, "utf8"), "true");
  } finally {
    const settled = monitor && (await monitor.terminate());
    if (settled?.status === "cleaned" || !wrapper?.pid)
      await rm(root, { recursive: true, force: true });
    else wrapper?.unref();
    assert.equal(settled?.status, "cleaned");
  }
});
