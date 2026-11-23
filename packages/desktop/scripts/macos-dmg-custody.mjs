/** Narrow custody for this fixture's hdiutil commands, never a general mount helper. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function isInside(parent, child) {
  const part = relative(parent, child);
  return Boolean(part && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

export function ownedImageFromInfo(info, image) {
  assert.ok(
    Array.isArray(info.images) && info.images.length < 1024,
    "Invalid hdiutil image metadata",
  );
  // Do not stat, resolve symlinks, or retain metadata for anybody else's image.
  const matches = info.images.filter((row) => row["image-path"] === image);
  assert.ok(matches.length <= 1, "Ambiguous owned disk image");
  if (!matches.length) return null;
  const entities = matches[0]["system-entities"];
  assert.ok(Array.isArray(entities) && entities.length < 64, "Invalid owned image entities");
  const devices = entities.map((row) => row["dev-entry"]).filter(Boolean);
  assert.ok(
    devices.length && devices.every((device) => /^\/dev\/disk\d+(?:s\d+)*$/.test(device)),
    "Invalid owned image device",
  );
  const mounts = entities.map((row) => row["mount-point"]).filter(Boolean);
  assert.equal(mounts.length, 1, "One owned image volume must be mounted");
  assert.ok(isAbsolute(mounts[0]), "Invalid owned mountpoint");
  return { image, devices, mountpoint: mounts[0] };
}

export function assertOwnedReadonlyVolume(volume, attachment) {
  assert.equal(volume.MountPoint, attachment.mountpoint, "Readonly mountpoint changed");
  assert.ok(attachment.devices.includes(volume.DeviceNode), "Foreign readonly volume device");
  assert.equal(volume.BusProtocol, "Disk Image", "Expected the owned mounted disk image");
  // Actual diskutil info -plist uses Writable* booleans, not ReadOnlyVolume.
  // Missing fields never count as readonly evidence.
  for (const key of ["Writable", "WritableVolume", "WritableMedia"])
    assert.equal(volume[key], false, `The actual mounted ${key} must be false`);
  return {
    mountpoint: volume.MountPoint,
    deviceNode: volume.DeviceNode,
    writable: volume.Writable,
    writableVolume: volume.WritableVolume,
    writableMedia: volume.WritableMedia,
  };
}

/** The install runner consumes a successful UI receipt only with final custody. */
export function assertInstalledUiReceipt(receipt, installed) {
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.suppliedApp, installed);
  assert.equal(receipt.operations.length, 13, "Every packaged UI operation must complete");
  assert.equal(receipt.localModelRequests, 0);
  assert.deepEqual(receipt.nativeCalls, []);
  assert.deepEqual(receipt.rendererErrors, [], "Late renderer errors must fail installation UI");
  assert.deepEqual(receipt.processEvidence.spawnedWorkers, []);
  assert.equal(receipt.privateHomeRemoved, true);
  assert.equal(receipt.artifacts.unchangedAfterRuntime, true);
  assert.equal(receipt.artifacts.mainExits.length, 1, "One installed Main must have exited");
  const main = receipt.artifacts.mainExits[0];
  assert.ok(Number.isSafeInteger(main.pid) && main.pid > 0);
  assert.equal(main.code, 0, "Installed Main must exit normally");
  assert.equal(main.signal, null, "Installed Main must not be terminated by a signal");
  const settlements = receipt.artifacts.observedProcessSettlements;
  assert.equal(settlements.length, 1, "Installed Main custody must settle exactly once");
  assert.equal(settlements[0].status, "cleaned");
  assert.equal(settlements[0].remainingCount, 0);
  assert.equal(settlements[0].queryFailed, false);
  const guards = receipt.processEvidence.mainGuards.filter((row) => row.role === "Main");
  assert.equal(guards.length, 1);
  assert.equal(guards[0].pid, main.pid, "Exit must belong to the guarded Main");
  const exits = receipt.processEvidence.mainSpawnExits;
  assert.equal(exits.length, 1);
  assert.equal(exits[0].pid, main.pid);
  assert.equal(exits[0].workerSpawnCount, 0, "No worker may spawn during shutdown");
  assert.equal(receipt.keychainContext.operatorDefaultUnchangedAfterRuntime, true);
}

// dmgbuild 75c8a6c creates its writable NamedTemporaryFile beside the final DMG.
export function ownedBuildAttachment(info, state) {
  assert.ok(Array.isArray(info.images) && info.images.length < 1024, "Invalid hdiutil metadata");
  const staged = info.images.filter((row) => {
    const image = row["image-path"];
    return (
      typeof image === "string" && dirname(image) === state.artifacts && image !== state.artifact
    );
  });
  assert.ok(staged.length <= 1, "Ambiguous images in the private build directory");
  if (!staged.length) return null;
  const image = staged[0]["image-path"];
  const name = basename(image);
  const suffix = basename(state.artifact);
  assert.ok(
    name.endsWith(suffix) && /^\.temp[a-z0-9_]{8}$/.test(name.slice(0, -suffix.length)),
    "Unexpected image in the private build directory",
  );
  const attachment = ownedImageFromInfo(info, image);
  assert.equal(attachment.mountpoint, state.stageMount, "Unexpected build mountpoint");
  return attachment;
}

export function authorizeDmgCommand(args, state) {
  assert.ok(
    Array.isArray(args) && args.every((arg) => typeof arg === "string" && !/[\0\r\n]/.test(arg)),
    "Invalid hdiutil arguments",
  );
  assert.ok(!args.includes("-force"), "Forced detach is forbidden");
  switch (args[0]) {
    case "attach": {
      assert.deepEqual(
        args,
        [
          "attach",
          "-readonly",
          "-nobrowse",
          "-noautoopen",
          "-mountpoint",
          state.readonlyMount,
          "-plist",
          state.artifact,
        ],
        "Expected read-only attach at the private mountpoint",
      );
      assert.ok(
        !state.attachments.some((row) => row.image === state.artifact && !row.detached),
        "Image already attached",
      );
      return {
        kind: "attach",
        image: state.artifact,
        mountpoint: state.readonlyMount,
        readonly: true,
      };
    }
    case "detach": {
      assert.equal(args.length, 3);
      assert.equal(args[1], "-quiet");
      const attachment = state.attachments.find(
        (row) => !row.detached && row.devices.includes(args[2]),
      );
      assert.ok(attachment, "Foreign or preexisting detach is forbidden");
      return { kind: "detach", image: attachment.image, attachment, device: args[2] };
    }
    case "verify":
      assert.deepEqual(args, ["verify", state.artifact]);
      return { kind: "verify", image: state.artifact };
    case "imageinfo":
      assert.deepEqual(args, ["imageinfo", "-plist", state.artifact]);
      return { kind: "imageinfo", image: state.artifact };
    default:
      throw new Error(`Unsupported fixture hdiutil command: ${args[0]}`);
  }
}

function readState(file) {
  assert.equal(realpathSync(file), resolve(file), "Guard reference must not traverse symlinks");
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(descriptor);
    assert.ok(
      info.isFile() &&
        info.uid === process.getuid() &&
        (info.mode & 0o777) === 0o600 &&
        info.nlink === 1 &&
        info.size <= 64 * 1024,
      "Invalid owned guard reference",
    );
    const state = JSON.parse(readFileSync(descriptor, "utf8"));
    const root = lstatSync(state.root);
    assert.ok(
      root.isDirectory() &&
        !root.isSymbolicLink() &&
        root.uid === process.getuid() &&
        (root.mode & 0o777) === 0o700,
    );
    assert.equal(realpathSync(state.root), state.root);
    assert.ok(
      isInside(state.root, file) && /^CodeShell-Owned-[a-f0-9-]{36}$/.test(state.volumeName),
    );
    assert.equal(state.stageMount, `/Volumes/${state.volumeName}`);
    for (const key of ["temporary", "artifacts", "readonlyMount"])
      assert.ok(isInside(state.root, state[key]));
    assert.equal(realpathSync(state.artifacts), state.artifacts);
    assert.equal(dirname(state.artifact), state.artifacts);
    assert.ok(state.artifact.endsWith(".dmg"));
    return state;
  } finally {
    closeSync(descriptor);
  }
}
function saveState(file, state) {
  const pending = file + ".next";
  writeFileSync(pending, JSON.stringify(state, null, 2), { flag: "wx", mode: 0o600 });
  renameSync(pending, file);
}
export function readOwnedDmgState(file) {
  return readState(file);
}
function readImages() {
  const xml = execFileSync("/usr/bin/hdiutil", ["info", "-plist"], {
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const json = execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
    input: xml,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse(json);
}

export function queryOwnedDmgImage(image) {
  return ownedImageFromInfo(readImages(), image);
}

// The native builder calls /usr/bin/hdiutil directly. After its process tree
// settles, recover its private scratch image or an interrupted read-only attach.
export function recoverDmgAttachments(file) {
  const state = readState(file);
  const info = readImages();
  const staged = ownedBuildAttachment(info, state);
  const final = ownedImageFromInfo(info, state.artifact);
  const live = [staged, final].filter(Boolean);
  for (const attachment of live) {
    const recorded = state.attachments.find(
      (row) => !row.detached && row.image === attachment.image,
    );
    if (recorded) {
      assert.equal(recorded.mountpoint, attachment.mountpoint, "Recorded mountpoint changed");
      assert.deepEqual(recorded.devices, attachment.devices, "Recorded devices changed");
      continue;
    }
    const readonly = attachment === final;
    if (readonly)
      assert.equal(attachment.mountpoint, state.readonlyMount, "Unexpected final mountpoint");
    state.attachments.push({ ...attachment, readonly, detached: false });
    saveState(file, state);
  }
  return live;
}

export function runGuardedHdiutil(file, args) {
  assert.equal(process.platform, "darwin");
  const state = readState(file);
  const command = authorizeDmgCommand(args, state);
  if (command.kind !== "detach") {
    const image = lstatSync(command.image);
    assert.ok(image.isFile() && image.uid === process.getuid() && image.nlink === 1);
    assert.equal(realpathSync(command.image), command.image);
  }
  if (command.kind === "attach")
    assert.equal(
      queryOwnedDmgImage(command.image),
      null,
      "Preexisting attached image is forbidden",
    );
  if (command.kind === "detach") {
    const current = queryOwnedDmgImage(command.image);
    assert.ok(current && current.devices.includes(command.device), "Owned device identity changed");
    assert.equal(current.mountpoint, command.attachment.mountpoint, "Owned mountpoint changed");
    assert.deepEqual(current.devices, command.attachment.devices, "Owned device set changed");
  }
  let output, failure;
  try {
    output = execFileSync("/usr/bin/hdiutil", args, {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: process.env.HOME,
        TMPDIR: state.temporary,
      },
    });
  } catch (error) {
    failure = error;
  }
  // Preserve ownership even when attach reports an error after mounting.
  if (command.kind === "attach") {
    const attached = queryOwnedDmgImage(command.image);
    if (attached) {
      state.attachments.push({ ...attached, readonly: command.readonly, detached: false });
      saveState(file, state);
      assert.equal(
        attached.mountpoint,
        command.mountpoint,
        "Unexpected owned image mountpoint; cleanup receipt retained",
      );
    }
    if (!failure) assert.ok(attached, "Attach returned without an owned mounted image");
  }
  if (failure) throw failure;
  if (command.kind === "detach") {
    assert.equal(queryOwnedDmgImage(command.image), null, "Owned image remains attached");
    command.attachment.detached = true;
  }
  state.commands.push({ kind: command.kind, image: command.image, completed: true });
  saveState(file, state);
  return output;
}

// Disk Arbitration can briefly return EBUSY even after the app exits. Check
// the live device and mountpoint again before each ordinary detach attempt.
export async function detachOwnedDmg(file, device) {
  const delays = [250, 1_000, 3_000];
  for (let attempt = 0; ; attempt++) {
    try {
      return runGuardedHdiutil(file, ["detach", "-quiet", device]);
    } catch (error) {
      if (error.status !== 16 || attempt === delays.length) throw error;
      await delay(delays[attempt]);
    }
  }
}
