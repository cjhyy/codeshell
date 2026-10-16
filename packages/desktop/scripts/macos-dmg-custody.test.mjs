import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeDmgCommand, ownedImageFromInfo } from "./macos-dmg-custody.mjs";

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

test("production create/attach accepts only a new owned image and fresh unique build mount", () => {
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
});

test("foreign mount/device and forced detach are refused before execution", () => {
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

test("read-only final mount cannot become writable or escape its owned mountpoint", () => {
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

test("image metadata selects exact owned image without adopting foreign or ambiguous disks", () => {
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
});

test("conversion rejects foreign source and preexisting artifact even with production -ov", () => {
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
});
