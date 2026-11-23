import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertInstalledUiReceipt,
  assertOwnedReadonlyVolume,
  authorizeDmgCommand,
  ownedImageFromInfo,
  ownedBuildAttachment,
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
  stageImage: `${root}/artifacts/.tempx0_abc12owned.dmg`,
  artifact: `${root}/artifacts/owned.dmg`,
  attachments: [],
  commands: [],
});
const row = (image, mountpoint, devices = ["/dev/disk90", "/dev/disk91s1"]) => ({
  "image-path": image,
  "system-entities": devices.map((device, index) => ({
    "dev-entry": device,
    ...(index === devices.length - 1 ? { "mount-point": mountpoint } : {}),
  })),
});

posixTest("dmgbuild scratch recovery requires both the private image and unique volume", () => {
  const value = state();
  const foreign = row("/operator/.tempx0_abc12owned.dmg", value.stageMount);
  const own = row(value.stageImage, value.stageMount);
  const final = row(value.artifact, value.readonlyMount);
  assert.equal(ownedBuildAttachment({ images: [foreign, final] }, value), null);
  assert.deepEqual(
    ownedBuildAttachment({ images: [foreign, own, final] }, value),
    ownedImageFromInfo({ images: [own] }, value.stageImage),
  );
  assert.throws(() => ownedBuildAttachment({ images: [own, own] }, value), /Ambiguous/);
  for (const [image, mountpoint] of [
    [value.artifacts + "/other.dmg", value.stageMount],
    [value.artifacts + "/.tempabcowned.dmg", value.stageMount],
    [value.artifacts + "/.tempx0_abc12other.dmg", value.stageMount],
    [value.stageImage, "/Volumes/foreign"],
  ])
    assert.throws(
      () => ownedBuildAttachment({ images: [row(image, mountpoint)] }, value),
      /Unexpected/,
    );
});

posixTest("foreign mount/device and forced detach are refused before execution", () => {
  const value = state();
  assert.throws(
    () => authorizeDmgCommand(["detach", "-quiet", value.stageMount], value),
    /Foreign or preexisting/,
  );
  value.attachments.push({
    image: value.stageImage,
    devices: ["/dev/disk90"],
    mountpoint: value.stageMount,
    detached: false,
  });
  assert.equal(
    authorizeDmgCommand(["detach", "-quiet", "/dev/disk90"], value).image,
    value.stageImage,
  );
  assert.throws(
    () => authorizeDmgCommand(["detach", "-quiet", "/dev/disk91"], value),
    /Foreign or preexisting/,
  );
  assert.throws(() => authorizeDmgCommand(["detach", "-force", "/dev/disk90"], value), /Forced/);
  value.attachments[0].detached = true;
  assert.throws(
    () => authorizeDmgCommand(["detach", "-quiet", "/dev/disk90"], value),
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
  assert.equal(authorizeDmgCommand(args, value).readonly, true);
  assert.throws(() =>
    authorizeDmgCommand(
      args.map((arg) => (arg === "-readonly" ? "-readwrite" : arg)),
      value,
    ),
  );
  assert.throws(
    () =>
      authorizeDmgCommand(
        args.map((arg) => (arg === value.readonlyMount ? "/Applications" : arg)),
        value,
      ),
    /Expected read-only/,
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

posixTest("only the final artifact may be verified or inspected", () => {
  const value = state();
  for (const args of [
    ["verify", value.artifact],
    ["imageinfo", "-plist", value.artifact],
  ]) {
    assert.equal(authorizeDmgCommand(args, value).image, value.artifact);
    assert.throws(() => authorizeDmgCommand([...args.slice(0, -1), "/foreign.dmg"], value));
  }
  for (const kind of ["create", "resize", "convert", "eject"]) {
    assert.throws(() => authorizeDmgCommand([kind, value.stageImage], value), /Unsupported/);
  }
});
