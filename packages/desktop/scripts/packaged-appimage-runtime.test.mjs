import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  assertAppImageMainIdentity,
  assertAppImagePayload,
  assertAppImagePayloadWithEvidence,
  inventoryAppImagePayload,
} from "./packaged-appimage-runtime.mjs";
import { inventoryAppTree, sha256 } from "./packaged-app-integrity.mjs";
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

test("managed Node public LICENSE permits only the builder's observed 0600 to 0644 copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "appimage-license-mode-"));
  try {
    const source = join(root, "source"),
      extracted = join(root, "extracted");
    const path = "resources/runtimes/node/LICENSE";
    for (const directory of [source, extracted])
      await mkdir(join(directory, "resources/runtimes/node"), { recursive: true });
    await chmod(join(source, "resources/runtimes/node"), 0o700);
    await writeFile(join(source, path), "owned public license");
    await chmod(join(source, path), 0o600);
    await writeFile(join(extracted, path), "owned public license");
    await chmod(join(extracted, path), 0o644);
    const before = await inventoryAppImagePayload(source);
    const changes = assertAppImagePayload(before, await inventoryAppImagePayload(extracted));
    assert.deepEqual(
      changes.filter((change) => change.type === "file"),
      [
        {
          path,
          type: "file",
          sourceMode: 0o600,
          extractedMode: 0o644,
          rule: "public managed Node LICENSE 0600 to 0644",
        },
      ],
    );
    assert.deepEqual(
      await inventoryAppImagePayload(source),
      before,
      "validation cannot rewrite source permissions",
    );
    await chmod(join(source, path), 0o644);
    assert.notDeepEqual(
      await inventoryAppImagePayload(source, before),
      before,
      "source mode drift remains visible without rehashing baseline bytes",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("payload modes retain type/byte/link and executable/write/privilege limits", () => {
  const license = ["resources/runtimes/node/LICENSE", "file", 0o600, 7, "owned-sha"];
  const source = [
    license,
    ["ordinary-private", "file", 0o600, 7, "owned-sha"],
    ["app", "file", 0o755, 7, "app-sha"],
    ["resources", "directory", 0o700],
    ["alias", "link", "app"],
  ];
  const valid = source.map((row) => [...row]);
  valid[0][2] = 0o644;
  valid[3][2] = 0o755;
  assert.equal(assertAppImagePayload(source, valid).length, 2);
  for (const mode of [0o755, 0o664, 0o666, 0o4644, 0o2644, 0o1644]) {
    const changed = valid.map((row) => [...row]);
    changed[0][2] = mode;
    assert.throws(() => assertAppImagePayload(source, changed));
  }
  for (const [index, field, value] of [
    [0, 1, "link"],
    [0, 3, 8],
    [0, 4, "changed-sha"],
    [1, 2, 0o644],
    [2, 2, 0o700],
    [3, 2, 0o775],
    [4, 2, "foreign"],
  ]) {
    const changed = valid.map((row) => [...row]);
    changed[index][field] = value;
    assert.throws(() => assertAppImagePayload(source, changed));
  }
  assert.throws(() =>
    assertAppImagePayload(source, [...valid, ["foreign-special", "file", 0o4755, 7, "owned-sha"]]),
  );
  const sandbox = [["chrome-sandbox", "file", 0o4755, 7, "sandbox-sha"]];
  assert.deepEqual(
    assertAppImagePayload(sandbox, [["chrome-sandbox", "file", 0o755, 7, "sandbox-sha"]]).map(
      (row) => row.extractedMode,
    ),
    [0o755],
  );
  assert.throws(() =>
    assertAppImagePayload(sandbox, [["chrome-sandbox", "file", 0o2755, 7, "sandbox-sha"]]),
  );
  assert.throws(
    () => assertAppImagePayload([["chrome-sandbox", "file", 0o755, 7, "sandbox-sha"]], sandbox),
    "new setuid cannot be introduced by extraction",
  );
});

test("observed AppImage runtime creates only exact 0755 source directories as private 0700", async () => {
  const root = await mkdtemp(join(tmpdir(), "appimage-private-directory-"));
  try {
    const source = join(root, "source"),
      extracted = join(root, "extracted");
    for (const directory of [source, extracted]) {
      await mkdir(join(directory, "locales"), { recursive: true });
      await writeFile(join(directory, "locales/en-US.pak"), "owned locale bytes");
      await chmod(join(directory, "locales/en-US.pak"), 0o644);
    }
    await chmod(join(source, "locales"), 0o755);
    await chmod(join(extracted, "locales"), 0o700);
    const before = await inventoryAppImagePayload(source);
    const actual = await inventoryAppImagePayload(extracted);
    assert.deepEqual(assertAppImagePayload(before, actual), [
      {
        path: "locales",
        type: "directory",
        sourceMode: 0o755,
        extractedMode: 0o700,
        rule: "AppImage runtime creates private directories 0755 to 0700",
      },
    ]);
    assert.deepEqual(await inventoryAppImagePayload(source), before);
    for (const mode of [0o000, 0o600, 0o710, 0o750, 0o705, 0o775, 0o777, 0o1700, 0o2700, 0o4700]) {
      const changed = actual.map((row) => [...row]);
      changed.find((row) => row[0] === "locales")[2] = mode;
      assert.throws(() => assertAppImagePayload(before, changed));
    }
    for (const mode of [0o555, 0o750, 0o705]) {
      const changed = before.map((row) => [...row]);
      changed.find((row) => row[0] === "locales")[2] = mode;
      assert.throws(() => assertAppImagePayload(changed, actual));
    }
    await writeFile(join(extracted, "locales/en-US.pak"), "changed locale bytes");
    const changedBytes = await inventoryAppImagePayload(extracted);
    assert.throws(() => assertAppImagePayload(before, changedBytes));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owned inventory retains SUID bits and detects runtime-added SUID/SGID", async () => {
  const root = await mkdtemp(join(tmpdir(), "appimage-full-mode-"));
  try {
    await writeFile(join(root, "owned-mode-file"), "never executed");
    await chmod(join(root, "owned-mode-file"), 0o644);
    const baseline = await inventoryAppImagePayload(root);
    for (const mode of [0o4644, 0o2644]) {
      await chmod(join(root, "owned-mode-file"), mode);
      assert.equal((await inventoryAppTree(root))[0][2], 0o644);
      const current = await inventoryAppImagePayload(root, baseline);
      assert.equal(current[0][2], mode);
      assert.notDeepEqual(current, baseline);
      assert.throws(() => assertAppImagePayload(baseline, current));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejected directory modes retain both complete permission inventories before throwing", async () => {
  const root = await mkdtemp(join(tmpdir(), "appimage-mode-evidence-"));
  try {
    const source = [
      ["locales", "directory", 0o755],
      ["chrome-sandbox", "file", 0o4755, 7, "owned-sha"],
      ["alias", "link", "locales"],
    ];
    // This partial-group mode is an unapproved owned counterexample.
    const extracted = source.map((row) => [...row]);
    extracted[0][2] = 0o750;
    const report = {};
    await assert.rejects(
      assertAppImagePayloadWithEvidence(source, extracted, { evidence: root, report }),
      /AppImage payload mode changed locales: source 0755, extracted 0750/,
    );
    assert.deepEqual(report.payloadModeFailure, {
      path: "locales",
      type: "directory",
      sourceMode: 0o755,
      extractedMode: 0o750,
      sourceModeOctal: "0755",
      extractedModeOctal: "0750",
    });
    for (const [index, inventory] of [source, extracted].entries()) {
      const metadata = report.payloadPermissionEvidence[index];
      const file = join(root, metadata.file);
      const json = await readFile(file, "utf8");
      assert.deepEqual(
        JSON.parse(json),
        inventory.map((row) => row.slice(0, 3)),
      );
      assert.equal(metadata.entries, inventory.length);
      assert.equal(metadata.bytes, Buffer.byteLength(json));
      assert.equal(metadata.sha256, sha256(json));
      assert.equal((await lstat(file)).mode & 0o7777, 0o600);
    }
    assert.equal(report.payloadModeNormalizations, undefined);
    const acceptedReport = {};
    const accepted = join(root, "accepted");
    await mkdir(accepted);
    assert.deepEqual(
      await assertAppImagePayloadWithEvidence(source, source, {
        evidence: accepted,
        report: acceptedReport,
      }),
      [],
    );
    assert.equal(acceptedReport.payloadModeFailure, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("oversized permission evidence fails closed without truncated files", async () => {
  const root = await mkdtemp(join(tmpdir(), "appimage-mode-evidence-bounds-"));
  try {
    for (const records of [
      Array.from({ length: 20_001 }, () => ["owned", "directory", 0o755]),
      [["x".repeat(4 * 1024 * 1024), "directory", 0o755]],
    ]) {
      const report = {};
      await assert.rejects(
        assertAppImagePayloadWithEvidence([], records, { evidence: root, report }),
        /payload permission inventory exceeds (row|byte) limit/,
      );
      assert.deepEqual(await readdir(root), []);
      assert.equal(report.payloadPermissionEvidence, undefined);
    }
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
