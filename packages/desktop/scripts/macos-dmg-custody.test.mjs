import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertInstalledUiReceipt,
  assertOwnedReadonlyVolume,
  authorizeDmgCommand,
  ownedImageFromInfo,
} from "./macos-dmg-custody.mjs";

// The production entry requires macOS; these fixtures use POSIX mount paths.
const posixTest = process.platform === "win32" ? test.skip : test;

const root = "/private/tmp/codeshell-owned-dmg-test";
const state = () => ({
  root,
  sourceApp: `${root}/original/code-shell.app`,
  arch: "arm64",
  volumeName: "CodeShell-Owned-00000000-0000-4000-8000-000000000001",
  stageMount: "/Volumes/CodeShell-Owned-00000000-0000-4000-8000-000000000001",
  temporary: `${root}/tmp`,
  artifacts: `${root}/artifacts`,
  readonlyMount: `${root}/readonly`,
  stageImage: `${root}/tmp/stage.dmg`,
  artifact: `${root}/artifacts/owned.dmg`,
  attachments: [],
  commands: [],
});
const fs = { exists: () => false, canonicalParent: (path) => path.slice(0, path.lastIndexOf("/")) };
const row = (image, mountpoint, devices = ["/dev/disk90", "/dev/disk91s1"]) => ({
  "image-path": image,
  "system-entities": devices.map((device, index) => ({
    "dev-entry": device,
    ...(index === devices.length - 1 ? { "mount-point": mountpoint } : {}),
  })),
});

posixTest(
  "production create/attach accepts only a new owned image and fresh unique build mount",
  () => {
    const value = state();
    delete value.stageImage;
    const args = [
      "create",
      "-srcfolder",
      value.sourceApp,
      "-volname",
      value.volumeName,
      "-anyowners",
      "-nospotlight",
      "-format",
      "UDRW",
      "-quiet",
      "-fs",
      "APFS",
      `${root}/tmp/stage.dmg`,
    ];
    assert.equal(authorizeDmgCommand(args, value, fs).kind, "create");
    assert.throws(
      () => authorizeDmgCommand(args, value, { ...fs, exists: () => true }),
      /Preexisting/,
    );
    assert.throws(() => authorizeDmgCommand([...args, "-attach"], value, fs), /Unexpected/);
    const current = state();
    const attach = ["attach", "-noverify", "-noautoopen", "-readwrite", current.stageImage];
    assert.equal(authorizeDmgCommand(attach, current, fs).mountpoint, current.stageMount);
    assert.throws(
      () => authorizeDmgCommand(attach, current, { ...fs, exists: () => true }),
      /Preexisting build mountpoint/,
    );
    assert.throws(
      () => authorizeDmgCommand([...attach.slice(0, -1), "/operator/foreign.dmg"], current, fs),
      /Foreign/,
    );
  },
);

posixTest("foreign mount/device and forced detach are refused before execution", () => {
  const value = state();
  assert.throws(
    () => authorizeDmgCommand(["detach", "-quiet", value.stageMount], value, fs),
    /Foreign or preexisting/,
  );
  value.attachments.push({
    image: value.stageImage,
    devices: ["/dev/disk90"],
    mountpoint: value.stageMount,
    detached: false,
  });
  assert.equal(
    authorizeDmgCommand(["detach", "-quiet", "/dev/disk90"], value, fs).image,
    value.stageImage,
  );
  assert.throws(
    () => authorizeDmgCommand(["detach", "-quiet", "/dev/disk91"], value, fs),
    /Foreign or preexisting/,
  );
  assert.throws(
    () => authorizeDmgCommand(["detach", "-force", "/dev/disk90"], value, fs),
    /Forced/,
  );
  value.attachments[0].detached = true;
  assert.throws(
    () => authorizeDmgCommand(["detach", "-quiet", "/dev/disk90"], value, fs),
    /Foreign or preexisting/,
  );
});

posixTest("read-only final mount cannot become writable or escape its owned mountpoint", () => {
  const value = state();
  const args = [
    "attach",
    "-readonly",
    "-nobrowse",
    "-noautoopen",
    "-mountpoint",
    value.readonlyMount,
    "-plist",
    value.artifact,
  ];
  assert.equal(authorizeDmgCommand(args, value, fs).readonly, true);
  assert.throws(() =>
    authorizeDmgCommand(
      args.map((arg) => (arg === "-readonly" ? "-readwrite" : arg)),
      value,
      fs,
    ),
  );
  assert.throws(
    () =>
      authorizeDmgCommand(
        args.map((arg) => (arg === value.readonlyMount ? "/Applications" : arg)),
        value,
        fs,
      ),
    /strictly equal/,
  );
});

test("readonly diskutil proof requires actual false flags and the recorded device/mount", () => {
  const attachment = { mountpoint: "/owned/readonly", devices: ["/dev/disk90s1"] };
  const volume = {
    MountPoint: attachment.mountpoint,
    DeviceNode: attachment.devices[0],
    BusProtocol: "Disk Image",
    Writable: false,
    WritableVolume: false,
    WritableMedia: false,
  };
  assert.equal(assertOwnedReadonlyVolume(volume, attachment).writableVolume, false);
  for (const key of ["Writable", "WritableVolume", "WritableMedia"]) {
    assert.throws(() => assertOwnedReadonlyVolume({ ...volume, [key]: true }, attachment));
    assert.throws(() => assertOwnedReadonlyVolume({ ...volume, [key]: undefined }, attachment));
  }
  assert.throws(() =>
    assertOwnedReadonlyVolume({ ...volume, MountPoint: "/operator/foreign" }, attachment),
  );
  assert.throws(() =>
    assertOwnedReadonlyVolume({ ...volume, DeviceNode: "/dev/disk91s1" }, attachment),
  );
});

test("installed UI requires normal guarded Main exit and final zero-worker custody", () => {
  const receipt = () => ({
    status: "passed",
    suppliedApp: "/owned/code-shell.app",
    operations: Array(13).fill({}),
    localModelRequests: 0,
    nativeCalls: [],
    rendererErrors: [],
    privateHomeRemoved: true,
    artifacts: {
      unchangedAfterRuntime: true,
      mainExits: [{ pid: 42, code: 0, signal: null }],
      observedProcessSettlements: [{ status: "cleaned", remainingCount: 0, queryFailed: false }],
    },
    processEvidence: {
      spawnedWorkers: [],
      mainGuards: [{ pid: 42, role: "Main" }],
      mainSpawnExits: [{ pid: 42, workerSpawnCount: 0 }],
    },
    keychainContext: { operatorDefaultUnchangedAfterRuntime: true },
  });
  assertInstalledUiReceipt(receipt(), "/owned/code-shell.app");
  for (const mutate of [
    (value) => (value.artifacts.mainExits[0].code = 1),
    (value) => (value.artifacts.mainExits[0].signal = "SIGTERM"),
    (value) => (value.artifacts.mainExits = []),
    (value) => (value.artifacts.observedProcessSettlements[0].status = "remaining"),
    (value) => (value.artifacts.observedProcessSettlements[0].queryFailed = true),
    (value) => (value.processEvidence.mainGuards[0].pid = 99),
    (value) => (value.processEvidence.mainSpawnExits[0].workerSpawnCount = 1),
    (value) => value.rendererErrors.push("late renderer error"),
    (value) => value.nativeCalls.push({ phase: "enter" }),
    (value) => (value.keychainContext.operatorDefaultUnchangedAfterRuntime = false),
  ]) {
    const value = receipt();
    mutate(value);
    assert.throws(() => assertInstalledUiReceipt(value, "/owned/code-shell.app"));
  }
});

posixTest(
  "image metadata selects exact owned image without adopting foreign or ambiguous disks",
  () => {
    const value = state();
    const owned = row(value.stageImage, value.stageMount);
    assert.deepEqual(
      ownedImageFromInfo(
        { images: [row("/operator/foreign.dmg", "/Volumes/operator"), owned] },
        value.stageImage,
      ),
      {
        image: value.stageImage,
        devices: ["/dev/disk90", "/dev/disk91s1"],
        mountpoint: value.stageMount,
      },
    );
    assert.equal(ownedImageFromInfo({ images: [owned] }, value.artifact), null);
    assert.throws(
      () => ownedImageFromInfo({ images: [owned, owned] }, value.stageImage),
      /Ambiguous/,
    );
    assert.throws(
      () =>
        ownedImageFromInfo(
          { images: [row(value.stageImage, value.stageMount, ["/dev/operator"])] },
          value.stageImage,
        ),
      /device/,
    );
  },
);

posixTest(
  "conversion rejects foreign source and preexisting artifact even with production -ov",
  () => {
    const value = state();
    value.attachments.push({ image: value.stageImage, detached: true });
    const args = [
      "convert",
      value.stageImage,
      "-ov",
      "-format",
      "UDZO",
      "-o",
      value.artifact,
      "-imagekey",
      "zlib-level=9",
      "-quiet",
    ];
    assert.equal(authorizeDmgCommand(args, value, fs).kind, "convert");
    assert.throws(
      () => authorizeDmgCommand(args, value, { ...fs, exists: () => true }),
      /Preexisting/,
    );
    assert.throws(
      () =>
        authorizeDmgCommand(
          args.map((arg) => (arg === value.stageImage ? "/operator/old.dmg" : arg)),
          value,
          fs,
        ),
      /Foreign convert/,
    );
    assert.throws(() => authorizeDmgCommand(["eject", "/dev/disk90"], value, fs), /Unsupported/);
  },
);
